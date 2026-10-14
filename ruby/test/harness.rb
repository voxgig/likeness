# frozen_string_literal: true

require 'json'
require 'minitest/autorun'

require_relative '../lib/likeness'

# The corpus runner every suite shares: an entry in, every way it failed out.
module Harness
  ROOT = File.expand_path('../..', __dir__)

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

  # Each connection becomes a declared station instance, its account the
  # likeness.json entry beside it, and its seed the SDK's offline transport.
  def build_ctx(entry)
    ectx = entry['ctx']
    seed = JSON.parse(read("fixtures/sources/#{ectx['fixture']}/seed.json"))
    seed.delete('_doc')

    sdk = {}
    accounts = {}
    fixture = {}
    ectx['connections'].each do |c|
      sdk[c['instance']] = {}
      accounts[c['instance']] = c['account']
      own = deep_copy(seed)
      own['net'] = c['net'] if c.key?('net')
      fixture[c['instance']] = own
    end

    # No PATH in the entry is `which` told about nothing, not about an empty list.
    Likeness::Ctx.new(argv: entry['args'], env: ectx['env'], clock: ectx['clock'], seed: ectx['seed'],
                      station: { 'station' => 1, 'profiles' => { 'default' => { 'sdk' => sdk } } },
                      accounts: accounts, fixture: fixture, path: ectx['path'])
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
    r = Likeness.run(build_ctx(entry))

    failures << "exit #{r.exit}, expected #{out['exit']}" if r.exit != out['exit']
    check_stdout(entry, r.stdout, failures)
    want_err = out['stderr'] || ''
    failures << "stderr #{JSON.generate(r.stderr)}, expected #{JSON.generate(want_err)}" if r.stderr != want_err
    failures << "calls #{JSON.generate(r.calls)}, expected #{JSON.generate(out['calls'])}" unless same_calls?(out['calls'], r.calls)
    failures
  end
end
