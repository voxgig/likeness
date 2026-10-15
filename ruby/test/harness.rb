# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'minitest/autorun'
require 'tmpdir'
require 'uri'

require_relative '../lib/likeness'

# The corpus runner every suite shares: an entry in, every way it failed out.
module Harness
  ROOT = File.expand_path('../..', __dir__)

  HOMES = []
  Minitest.after_run { HOMES.each { |home| FileUtils.rm_rf(home) } }

  # The prompts each run showed, for the entry to compare.
  PROMPTS = {}.compare_by_identity

  CONFIG_FILES = %w[station.json likeness.json].freeze

  module_function

  def read(rel)
    File.read(File.join(ROOT, rel), encoding: 'UTF-8')
  end

  def corpus(name)
    JSON.parse(read("spec/#{name}.json"))['primary'][name]
  end

  def entries(name)
    groups = corpus(name)
    groups.keys.sort.flat_map { |g| groups[g]['set'] }
  end

  def deep_copy(value)
    Marshal.load(Marshal.dump(value))
  end

  def seed_of(name)
    seed = JSON.parse(read("fixtures/sources/#{name}/seed.json"))
    seed.delete('_doc')
    seed
  end

  # Each connection becomes a declared station instance, its block the one the
  # entry gives, its account the likeness.json entry beside it, and its seed,
  # its own or the entry's, the SDK's offline transport. Every run gets a home
  # of its own, holding the entry's files; an entry that brings station.json or
  # likeness.json is configured by them alone, read as the argv shell reads them.
  def build_ctx(entry)
    ectx = entry['ctx']
    sdk = {}
    accounts = {}
    fixture = {}
    ectx['connections'].each do |c|
      sdk[c['instance']] = deep_copy(c['block'] || {})
      accounts[c['instance']] = c['account']
      own = seed_of(c['fixture'] || ectx['fixture'])
      own['net'] = c['net'] if c.key?('net')
      fixture[c['instance']] = own
    end

    home = Dir.mktmpdir('likeness-')
    HOMES << home
    dir = File.join(home, '.config', 'likeness')
    FileUtils.mkdir_p(dir)
    (ectx['files'] || {}).each do |name, src|
      dst = run_path(home, dir, name)
      FileUtils.mkdir_p(File.dirname(dst))
      FileUtils.cp(File.join(ROOT, src), dst)
    end

    profile = { 'sdk' => sdk }
    profile['secrets'] = ectx['secrets'] if ectx.key?('secrets')
    station = { 'station' => 1, 'profiles' => { 'default' => profile } }
    if (ectx['files'] || {}).keys.any? { |name| CONFIG_FILES.include?(name) }
      if !ectx['connections'].empty? || ectx.key?('secrets')
        raise "#{entry['id']}: an entry that brings its configuration declares no connections or secrets"
      end

      station, accounts = Likeness.load_config(File.join(dir, 'station.json'), Likeness.profile_of(ectx['env']))
    end

    # No PATH in the entry is `which` told about nothing, not about an empty list.
    ctx = Likeness::Ctx.new(argv: entry['args'], env: ectx['env'], clock: ectx['clock'], seed: ectx['seed'],
                            station: station, accounts: accounts, fixture: fixture, path: ectx['path'],
                            home: home, dir: dir, config: File.join(dir, 'station.json'),
                            stdin: -> { ectx['stdin'] || '' }, presented: presenter(ectx['presents'] || {}))
    if ectx.key?('tty')
      typed = ectx['tty'].dup
      shown = []
      ctx.tty = true
      ctx.prompt = lambda { |label|
        shown << label
        typed.shift
      }
      PROMPTS[ctx] = shown
    end
    ctx
  end

  # Keyed by host:port, the port written out even where it is the scheme's.
  def presenter(presents)
    lambda do |base|
      uri = URI.parse(base)
      at = "#{uri.host}:#{uri.port}"
      raise "nothing answers at #{at}" unless presents.key?(at)

      presents[at]
    end
  end

  # A file the entry names: under the home with `~/`, else in the configuration directory.
  def run_path(home, dir, name)
    name.start_with?('~/') ? File.join(home, name[2..]) : File.join(dir, name)
  end

  def located(ctx, name)
    run_path(ctx.home, ctx.dir, name)
  end

  def vault_failures(entry, ctx, failures)
    want = entry['out']['vault']
    return if want.nil?

    file = run_path(ctx.home, ctx.dir, want['file'] || 'likeness.skmv')
    vault = VoxgigSekreto.openvault('file' => file, 'key' => want['key'] || 'master', 'passphrase' => want['passphrase'])
    begin
      names = vault.list
    rescue StandardError => e
      failures << "the vault does not open afterwards: #{e.message}"
      return
    end
    failures << "vault names #{JSON.generate(names)}, expected #{JSON.generate(want['names'])}" if names != want['names']
    if want.key?('keys')
      fields = %w[key master write grants]
      keys = vault.keys.sort_by { |k| k['key'] }.map { |k| k.slice(*fields) }
      if keys != want['keys'].map { |k| k.slice(*fields) }
        failures << "vault keys #{JSON.generate(keys)}, expected #{JSON.generate(want['keys'])}"
      end
    end
    (want['values'] || {}).each do |name, value|
      failures << "vault value of #{name} is not the one expected" if vault.get(name) != value
    end
  end

  # The configuration directory afterwards: each named file byte for byte, and
  # the absent ones not there.
  def file_failures(entry, ctx, failures)
    (entry['out']['files'] || {}).each do |name, want|
      at = located(ctx, name)
      if !File.exist?(at)
        failures << "#{name} is not there afterwards, and #{want} says what it holds"
      elsif File.binread(at) != File.binread(File.join(ROOT, want))
        failures << "#{name} differs from #{want}"
      end
    end
    (entry['out']['absent'] || []).each do |name|
      failures << "#{name} is there afterwards, and the entry says it is not" if File.exist?(located(ctx, name))
    end
  end

  def member(value, key)
    value.is_a?(Hash) ? value[key] : nil
  end

  def check_stdout(entry, actual, failures)
    path = entry['out']['stdout']
    want = read(path)

    unless path.end_with?('.json')
      failures << "stdout bytes differ from #{path}" if actual != want
      return
    end

    begin
      parsed = JSON.parse(actual)
    rescue JSON::ParserError
      failures << "stdout is not JSON, and #{path} says it should be"
      return
    end

    # Raw bytes first: indented or CRLF output carries the right values in the
    # wrong bytes, and a value comparison alone lets that through.
    if actual != Likeness.serialise(parsed)
      failures << 'stdout is not in canonical form (sorted keys, one line, one trailing newline): ' \
                  "#{JSON.generate(actual[0, 80])}"
    end

    # Removed from the comparison, so asserted here instead.
    port = member(parsed, 'port')
    failures << "envelope port is \"#{port}\", expected \"#{Likeness::PORT}\"" if Likeness::PORT != port
    data = member(parsed, 'data')
    if data.is_a?(Hash) && data.key?('port') && Likeness::PORT != data['port']
      failures << "data.port is \"#{data['port']}\", expected \"#{Likeness::PORT}\""
    end
    elapsed = member(member(parsed, 'meta'), 'elapsed_ms')
    unless elapsed.is_a?(Integer) && !elapsed.negative?
      failures << "meta.elapsed_ms is #{JSON.generate(elapsed)}, expected a non-negative integer"
    end

    got = Likeness.serialise(Likeness.strip_parity_exceptions(parsed))
    failures << "stdout differs from #{path}\n  want #{want.rstrip}\n  got  #{got.rstrip}" if got != want
  end

  # The stdout checks alone, over bytes the caller supplies: the meta-tests
  # hand the harness output no port produced.
  def stdout_failures(entry, actual)
    [].tap { |failures| check_stdout(entry, actual, failures) }
  end

  def same_calls?(want, got)
    want.length == got.length && want.zip(got).all? do |w, g|
      %w[instance method path].all? { |k| w[k] == g[k] }
    end
  end

  # The entries whose calls this port's SDK spells differently on the wire: its
  # vendored VoxgigStruct.escurl percent-encodes the characters `!'()*` that
  # encodeURIComponent keeps. Their calls are compared with that spelling
  # applied, and an entry whose calls match outright fails, as it no longer differs.
  ESCURL_DIVERGES = %w[obsidian/list-odd-values obsidian/list-odd-raw].freeze

  def escurl(path)
    path.gsub(/[!'()*]/) { |c| format('%%%02X', c.ord) }
  end

  def calls_failures(entry, got, failures)
    want = entry['out']['calls']
    if ESCURL_DIVERGES.include?(entry['id'])
      if same_calls?(want, got)
        failures << "calls match the expectation outright, so #{entry['id']} no longer belongs in ESCURL_DIVERGES"
        return
      end
      want = want.map { |c| c.merge('path' => escurl(c['path'])) }
    end
    failures << "calls #{JSON.generate(got)}, expected #{JSON.generate(want)}" unless same_calls?(want, got)
  end

  def check(entry)
    failures = []
    out = entry['out']
    ctx = build_ctx(entry)
    r = Likeness.run(ctx)

    failures << "exit #{r.exit}, expected #{out['exit']}" if r.exit != out['exit']
    check_stdout(entry, r.stdout, failures)
    want_err = out['stderr'] || ''
    failures << "stderr #{JSON.generate(r.stderr)}, expected #{JSON.generate(want_err)}" if r.stderr != want_err
    calls_failures(entry, r.calls, failures)
    prompts = PROMPTS[ctx] || []
    want_prompts = out['prompts'] || []
    failures << "prompts #{JSON.generate(prompts)}, expected #{JSON.generate(want_prompts)}" if prompts != want_prompts
    vault_failures(entry, ctx, failures)
    file_failures(entry, ctx, failures)
    failures
  end
end
