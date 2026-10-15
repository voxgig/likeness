# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'minitest/autorun'
require 'tmpdir'

require_relative '../lib/likeness'

# The corpus runner every suite shares: an entry in, every way it failed out.
module Harness
  ROOT = File.expand_path('../..', __dir__)

  HOMES = []
  Minitest.after_run { HOMES.each { |home| FileUtils.rm_rf(home) } }

  # The prompts each run showed, for the entry to compare.
  PROMPTS = {}.compare_by_identity

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
  # of its own, holding the entry's files.
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

    # No PATH in the entry is `which` told about nothing, not about an empty list.
    ctx = Likeness::Ctx.new(argv: entry['args'], env: ectx['env'], clock: ectx['clock'], seed: ectx['seed'],
                            station: { 'station' => 1, 'profiles' => { 'default' => profile } },
                            accounts: accounts, fixture: fixture, path: ectx['path'],
                            home: home, dir: dir, stdin: -> { ectx['stdin'] || '' })
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

  def run_path(home, dir, name)
    name.start_with?('~/') ? File.join(home, name[2..]) : File.join(dir, name)
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

  def check(entry)
    failures = []
    out = entry['out']
    ctx = build_ctx(entry)
    r = Likeness.run(ctx)

    failures << "exit #{r.exit}, expected #{out['exit']}" if r.exit != out['exit']
    check_stdout(entry, r.stdout, failures)
    want_err = out['stderr'] || ''
    failures << "stderr #{JSON.generate(r.stderr)}, expected #{JSON.generate(want_err)}" if r.stderr != want_err
    failures << "calls #{JSON.generate(r.calls)}, expected #{JSON.generate(out['calls'])}" unless same_calls?(out['calls'], r.calls)
    prompts = PROMPTS[ctx] || []
    want_prompts = out['prompts'] || []
    failures << "prompts #{JSON.generate(prompts)}, expected #{JSON.generate(want_prompts)}" if prompts != want_prompts
    vault_failures(entry, ctx, failures)
    failures
  end
end
