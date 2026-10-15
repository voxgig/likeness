# frozen_string_literal: true

require 'io/console'
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

  # A number past a double's range: JSON.parse reads it as an infinity, or as an
  # integer no double holds, and the canonical port reads every number as one.
  def finite?(doc)
    pending = [doc]
    until pending.empty?
      value = pending.pop
      case value
      when Float then return false unless value.finite?
      when Integer then return false unless value.to_f.finite?
      when Hash then pending.concat(value.values)
      when Array then pending.concat(value)
      end
    end
    true
  end

  def parse_json(source, path)
    begin
      raise JSON::ParserError if source.scan(NOT_JSON).any? { |escape, slash| escape || slash }

      doc = JSON.parse(source)
      raise JSON::ParserError unless finite?(doc)
    rescue JSON::ParserError
      raise ConfigError, "#{path} is not valid JSON"
    end
    raise ConfigError, "#{path} is not a JSON object" unless doc.is_a?(Hash)

    doc
  end

  # station.json, validated by station against its own shape. Its secret chain
  # is likeness's to check, and is checked when it is used.
  def parse_station(source, path)
    doc = parse_json(source, path)
    begin
      open_station(with_chain(doc, []))
    rescue StandardError => e
      code = e.respond_to?(:code) ? e.code : nil
      raise ConfigError, "#{path}: #{e.message}" if code.is_a?(String) && code.start_with?('station_')

      raise
    end
    doc
  end

  # Read as JavaScript reads `value[key]`, so a malformed file is never a crash.
  def member_of(value, key)
    return value[key] if value.is_a?(Hash)
    return nil unless value.is_a?(Array) && /\A(?:0|[1-9][0-9]*)\z/.match?(key) && Integer(key, 10) < value.length

    value[Integer(key, 10)]
  end

  # The account each instance ref of one station profile belongs to, from
  # likeness.json. A profile reads only its own: none is inherited.
  def parse_accounts(source, path, profile)
    instances = member_of(member_of(member_of(parse_json(source, path), 'profiles'), profile), 'instances')
    instances = instances.each_with_index.to_h { |v, i| [i.to_s, v] } if instances.is_a?(Array)
    return {} unless instances.is_a?(Hash)

    instances.keys.sort { |a, b| compare_code_points(a, b) }.each_with_object({}) do |ref, out|
      account = instances[ref].is_a?(Hash) ? instances[ref]['account'] : nil
      out[ref] = text_of(account) unless account.nil?
    end
  end

  # nil when the file is not there. One that is there and cannot be read as a
  # file, such as a directory, is refused rather than taken for absent.
  def read_config(path)
    return nil unless File.exist?(path)

    begin
      File.read(path, encoding: 'UTF-8').scrub
    rescue SystemCallError, IOError
      raise ConfigError, "#{path} cannot be read"
    end
  end

  def load_config(path, profile)
    source = read_config(path)
    return [nil, {}] if source.nil?

    station = parse_station(source, path)
    lpath = File.join(File.dirname(path), 'likeness.json')
    lsource = read_config(lpath)
    [station, lsource.nil? ? {} : parse_accounts(lsource, lpath, profile)]
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

  # One line from the terminal with echo off; nil at the end of input.
  def prompt(label, stdin, stderr)
    stderr.write("#{label}: ")
    stderr.flush
    line = stdin.noecho(&:gets)
    line&.chomp&.force_encoding(Encoding::UTF_8)&.scrub
  rescue Interrupt
    exit 130
  ensure
    stderr.write("\n")
  end

  def main(argv, stdout: $stdout, stderr: $stderr, env: ENV.to_h, stdin: $stdin)
    taken = take_config_option(argv)
    home = env.fetch('HOME') { Dir.home }
    path = taken['value'] || joined(home, '.config', 'likeness', 'station.json')
    begin
      station, accounts = load_config(path, profile_of(env))
    rescue ConfigError => e
      stderr.write("error: invalid-project\n  #{e.message}\n  remedy  #{CONFIG_REMEDY}\n")
      return 3
    end

    clock = rfc3339(Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond))
    ctx = Ctx.new(argv: taken['rest'], env: env, clock: clock, station: station, accounts: accounts,
                  path: probe_path(env), home: home, dir: File.dirname(path),
                  stdin: -> { stdin.binmode.read.force_encoding(Encoding::UTF_8).scrub },
                  tty: stdin.tty?, prompt: ->(label) { prompt(label, stdin, stderr) })
    res = run(ctx)
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
