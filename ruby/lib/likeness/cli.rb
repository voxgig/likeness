# frozen_string_literal: true

require 'json'
require 'pathname'

require_relative 'core'

module Likeness
  class ConfigError < StandardError; end

  CONFIG_REMEDY = 'fix the file, or point --config at another'
  PROBE_RE = /\Alikeness(?:-([a-z]+))?\z/
  # Ruby's JSON.parse also reads comments and unknown escapes, which JSON and
  # the other ports refuse.
  NOT_JSON = %r{"(?:[^"\\]|\\["\\/bfnrt]|\\u\h{4}|(\\))*"?|(/)}

  module_function

  def parse_json(source, path)
    raise JSON::ParserError if source.scan(NOT_JSON).any? { |escape, slash| escape || slash }

    JSON.parse(source)
  rescue JSON::ParserError
    raise ConfigError, "#{path} is not valid JSON"
  end

  # station.json, validated by station against its own shape.
  def parse_station(source, path)
    doc = parse_json(source, path)
    begin
      open_station(doc)
    rescue VoxgigStation::StationError => e
      raise ConfigError, "#{path}: #{e.message}" if 'station_config_invalid' == e.code

      raise
    end
    doc
  end

  # The account each instance ref belongs to, from likeness.json.
  def parse_accounts(source, path)
    doc = parse_json(source, path)
    instances = doc.is_a?(Hash) ? doc['instances'] : nil
    instances = instances.each_with_index.to_h { |v, i| [i.to_s, v] } if instances.is_a?(Array)
    return {} unless instances.is_a?(Hash)

    instances.keys.sort { |a, b| compare_code_points(a, b) }.each_with_object({}) do |ref, out|
      account = instances[ref].is_a?(Hash) ? instances[ref]['account'] : nil
      out[ref] = text_of(account) unless account.nil?
    end
  end

  def read_text(path)
    File.read(path, encoding: 'UTF-8').scrub
  end

  def load_config(config_path)
    path = config_path || File.join(Dir.home, '.config', 'likeness', 'station.json')
    return [nil, {}] unless File.exist?(path)

    station = parse_station(read_text(path), path)
    lpath = File.join(File.dirname(path), 'likeness.json')
    [station, File.exist?(lpath) ? parse_accounts(read_text(lpath), lpath) : {}]
  end

  def probe_path(env)
    seen = {}
    rows = []
    env.fetch('PATH', '').split(File::PATH_SEPARATOR).each do |dir|
      next if dir.empty?

      names = begin
        Dir.children(dir).sort
      rescue SystemCallError
        next
      end
      names.each do |name|
        m = PROBE_RE.match(name)
        next if m.nil?

        full = Pathname.new(dir).join(name).cleanpath.to_s
        next if seen.key?(full) || !File.file?(full)

        seen[full] = true
        # The port is read from the file NAME: `which` must not run whatever is
        # on PATH under a matching name, and a bare `likeness` names no port.
        rows << { 'path' => full, 'port' => m[1] || '', 'version' => '' }
      end
    end
    rows << { 'path' => '(this port, not on PATH)', 'port' => PORT, 'version' => VERSION } if rows.empty?
    rows
  end

  # `--config PATH` or `--config=PATH`, taken out before the command runs. Only
  # one well-formed occurrence after the command and before `--` is taken;
  # anything else is left for the grammar to refuse.
  def take_config_option(argv)
    found = []
    bad = false
    i = 0
    while (i += 1) < argv.length
      arg = argv[i]
      break if '--' == arg

      if '--config' == arg
        following = argv[i + 1]
        if following.nil? || flag_shaped?(following)
          bad = true
        else
          found << [i, 2, following]
        end
        i += 1
      elsif arg.start_with?('--config=')
        value = arg.delete_prefix('--config=')
        if value.empty?
          bad = true
        else
          found << [i, 1, value]
        end
      end
    end
    return { 'rest' => argv.dup } if bad || 1 != found.length

    at, width, value = found[0]
    { 'rest' => argv[0...at] + argv[(at + width)..], 'value' => value }
  end

  def main(argv, stdout: $stdout, stderr: $stderr, env: ENV.to_h)
    taken = take_config_option(argv)
    begin
      station, accounts = load_config(taken['value'])
    rescue ConfigError => e
      stderr.write("error: invalid-project\n  #{e.message}\n  remedy  #{CONFIG_REMEDY}\n")
      return 3
    end

    res = run(Ctx.new(argv: taken['rest'], env: env, clock: rfc3339(Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond)),
                      station: station, accounts: accounts, path: probe_path(env)))
    # A reader that went away is not the port's failure: exit quietly with 0.
    begin
      [[stdout, res.stdout], [stderr, res.stderr]].each do |io, text|
        next if text.empty?

        io.write(text)
        io.flush
      end
    rescue Errno::EPIPE
      return 0
    end
    res.exit
  end
end
