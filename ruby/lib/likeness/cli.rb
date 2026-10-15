# frozen_string_literal: true

require 'io/console'
require 'pathname'

require_relative 'config'
require_relative 'core'
require_relative 'pin'

module Likeness
  PROBE_RE = /\Alikeness(?:-([a-z]+))?\z/

  module_function

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

  # One line from the terminal with echo off; nil at the end of input. Echo goes
  # off before the label shows, or an answer typed the moment it appears is echoed.
  def prompt(label, stdin, stderr)
    line = stdin.noecho do |io|
      stderr.write("#{label}: ")
      stderr.flush
      io.gets
    end
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
                  path: probe_path(env), home: home, dir: File.dirname(path), config: path,
                  stdin: -> { stdin.binmode.read.force_encoding(Encoding::UTF_8).scrub },
                  tty: stdin.tty?, prompt: ->(label) { prompt(label, stdin, stderr) },
                  presented: ->(base) { presented_fingerprint(base) })
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
