# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'minitest/autorun'
require 'tmpdir'
require 'uri'

require_relative '../lib/likeness'

# The transcript corpus's subject for omni: a whole command in-process, held to
# the committed bytes.
module Harness
  ROOT = File.expand_path('../..', __dir__)

  # Linked by `make rb-deps` beside the library checkouts, and loaded by the tests alone.
  OMNI_LIB = File.join(Likeness::VENDOR, 'omni', 'ruby', 'lib')
  raise LoadError, "likeness: #{OMNI_LIB} is missing - run `make rb-deps`" unless File.directory?(OMNI_LIB)

  $LOAD_PATH.unshift(OMNI_LIB) unless $LOAD_PATH.include?(OMNI_LIB)
  require 'voxgig_omni'

  HOMES = []
  Minitest.after_run { HOMES.each { |home| FileUtils.rm_rf(home) } }

  # The prompts each run showed, for the subject to report.
  PROMPTS = {}.compare_by_identity

  CONFIG_FILES = %w[station.json likeness.json].freeze

  module_function

  def read(rel)
    File.read(File.join(ROOT, rel), encoding: 'UTF-8')
  end

  def document(name)
    JSON.parse(read("spec/#{name}.json"))
  end

  def corpus(name)
    document(name)['primary'][name]
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

  KEY_FIELDS = %w[key master write grants].freeze
  CALL_FIELDS = %w[instance method path].freeze

  # Bytes as a UTF-8 string, unchecked, so a comparison stays byte for byte.
  def text(path)
    File.binread(path).force_encoding(Encoding::UTF_8)
  end

  # The vault afterwards, as much of it as the entry asserts: its names, its
  # keys if the entry gives them, and the values it names.
  def vault_seen(want, ctx, faults)
    file = located(ctx, want['file'] || 'likeness.skmv')
    vault = VoxgigSekreto.openvault('file' => file, 'key' => want['key'] || 'master',
                                    'passphrase' => want['passphrase'])
    seen = { 'names' => vault.list }
  rescue StandardError => e
    faults << "the vault does not open afterwards: #{e.message}"
    nil
  else
    seen['keys'] = vault.keys.sort_by { |k| k['key'] }.map { |k| k.slice(*KEY_FIELDS) } if want['keys']
    seen['values'] = want['values'].to_h { |name| [name, vault.get(name)] } if want.key?('values')
    seen
  end

  def member(value, key)
    value.is_a?(Hash) ? value[key] : nil
  end

  # The stdout to compare: as printed, or for JSON the canonical bytes less
  # the fields that may differ by port, each of those asserted here instead.
  def seen_stdout(json_wanted, actual, faults)
    return actual unless json_wanted

    begin
      parsed = JSON.parse(actual)
    rescue JSON::ParserError
      faults << 'stdout is not JSON, and the entry says it should be'
      return actual
    end

    # Raw bytes first: indented or CRLF output carries the right values in the
    # wrong bytes, and a value comparison alone lets that through.
    begin
      canonical = Likeness.serialise(parsed)
    rescue Likeness::SerialiseError => e
      faults << "stdout cannot be re-rendered: #{e.message}"
      return actual
    end
    if actual != canonical
      faults << 'stdout is not in canonical form (sorted keys, one line, one trailing newline): ' \
                "#{JSON.generate(actual[0, 80])}"
    end

    port = member(parsed, 'port')
    faults << "envelope port is #{JSON.generate(port)}, expected \"#{Likeness::PORT}\"" if Likeness::PORT != port
    data = member(parsed, 'data')
    if data.is_a?(Hash) && data.key?('port') && Likeness::PORT != data['port']
      faults << "data.port is #{JSON.generate(data['port'])}, expected \"#{Likeness::PORT}\""
    end
    elapsed = member(member(parsed, 'meta'), 'elapsed_ms')
    unless elapsed.is_a?(Integer) && !elapsed.negative?
      faults << "meta.elapsed_ms is #{JSON.generate(elapsed)}, expected a non-negative integer"
    end

    Likeness.serialise(Likeness.strip_parity_exceptions(parsed))
  end

  # The stdout checks alone, over bytes no port produced, for the meta-tests.
  def stdout_failures(entry, actual)
    rel = entry['out']['stdout']
    faults = []
    seen = seen_stdout(rel.end_with?('.json'), actual, faults)
    faults << "stdout differs from #{rel}" if seen != text(File.join(ROOT, rel))
    faults
  end

  # The entry as omni runs it. What the entry's `out` names by path becomes
  # the bytes, and what the subject must look at to answer it rides in `ctx`.
  def resolved(entry)
    out = entry['out']
    observe = { 'id' => entry['id'], 'json' => out['stdout'].end_with?('.json') }
    want = {
      'exit' => out['exit'],
      'stdout' => text(File.join(ROOT, out['stdout'])),
      'stderr' => out['stderr'] || '',
      'calls' => out['calls'].map { |c| c.slice(*CALL_FIELDS) },
      'prompts' => out['prompts'] || [],
      'faults' => []
    }
    if out.key?('vault')
      v = out['vault']
      observe['vault'] = v.slice('file', 'key', 'passphrase').merge('keys' => v.key?('keys'))
      observe['vault']['values'] = v['values'].keys.sort if v.key?('values')
      want['vault'] = { 'names' => v['names'] }
      want['vault']['keys'] = v['keys'].map { |k| k.slice(*KEY_FIELDS) } if v.key?('keys')
      want['vault']['values'] = v['values'] if v.key?('values')
    end
    if out.key?('files')
      observe['files'] = out['files'].keys.sort
      want['files'] = out['files'].transform_values { |f| text(File.join(ROOT, f)) }
    end
    if out.key?('absent')
      observe['absent'] = out['absent'].dup
      want['absent'] = out['absent'].dup
    end
    { 'id' => entry['id'], 'args' => entry['args'], 'ctx' => entry['ctx'].merge('observe' => observe), 'out' => want }
  end

  # omni's subject for the transcript corpus: one command, in-process.
  def transcript(ctx, *argv)
    observe = ctx['observe']
    c = build_ctx({ 'id' => observe['id'], 'args' => argv, 'ctx' => ctx.except('observe', 'client') })
    r = Likeness.run(c)
    faults = []
    seen = {
      'exit' => r.exit,
      'stdout' => seen_stdout(observe['json'], r.stdout, faults),
      'stderr' => r.stderr,
      'calls' => r.calls.map { |call| call.slice(*CALL_FIELDS) },
      'prompts' => PROMPTS[c] || [],
      'faults' => faults
    }
    seen['vault'] = vault_seen(observe['vault'], c, faults) if observe.key?('vault')
    if observe.key?('files')
      seen['files'] = observe['files'].to_h do |name|
        at = located(c, name)
        [name, File.exist?(at) ? text(at) : nil]
      end
    end
    seen['absent'] = observe['absent'].reject { |name| File.exist?(located(c, name)) } if observe.key?('absent')
    seen
  end

  CLI_OMNI = { 'version' => 1, 'requires' => ['ctxargs'] }.freeze

  def cli_runner(spec)
    subject = Harness.method(:transcript)
    VoxgigOmni.make_runner(spec, { subject: ->(name) { 'cli' == name ? subject : nil } }).call('cli')
  end

  def run_group(name, entries, flags)
    spec = { 'OMNI' => CLI_OMNI, 'cli' => { name => { 'set' => entries.map { |e| resolved(e) } } } }
    cli_runner(spec)[:runsetflags].call(spec['cli'][name], flags)
  end

  # One entry through omni: no failures, or the one omni reports.
  def check(entry, wait: nil)
    run_group('one', [entry], wait.nil? ? { null: false } : { null: false, wait: { entry['id'] => wait } })
    []
  rescue VoxgigOmni::OmniError => e
    [e.message]
  end

  ESCURL = "voxgig/sdkgen#418: the Ruby obsidian-sdk's VoxgigStruct.escurl percent-encodes !'()* in a path, " \
           "where the canonical port's encodeURIComponent keeps them"

  # The entry as this SDK's escaping answers it: each of !'()* in a path percent-encoded.
  ESCAPED_AS_QUOTE = lambda do |entry|
    Harness.deep_copy(entry).tap do |e|
      e['out']['calls'].each { |c| c['path'] = c['path'].gsub(/[!'()*]/) { |ch| format('%%%02X', ch.ord) } }
    end
  end

  # Entries this port cannot answer yet, each with the upstream cause it waits
  # on and the entry as that cause predicts it answers.
  WAITING = {
    'obsidian/list-odd-raw' => [ESCURL, ESCAPED_AS_QUOTE],
    'obsidian/list-odd-values' => [ESCURL, ESCAPED_AS_QUOTE]
  }.freeze
end
