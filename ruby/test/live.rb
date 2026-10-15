# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'net/http'
require 'openssl'
require 'timeout'
require 'tmpdir'
require 'uri'

require_relative 'harness'

# A station-bound client against mock/, its tokens in a throwaway vault.
module Live
  PASSPHRASE = 'wire suite passphrase'

  DIRS = []
  Minitest.after_run { DIRS.each { |dir| FileUtils.rm_rf(dir) } }

  Bound = Struct.new(:station, :calls, :conns, keyword_init: true)

  # mock/server.js with options it reads only in-process: a subset of sources, and TLS.
  SERVER = <<~JS
    const { buildServer } = await import(process.env.LIKENESS_MOCK_URL)
    const opts = JSON.parse(process.env.LIKENESS_MOCK_OPTS)
    const app = await buildServer(opts)
    await app.listen({ port: 0, host: '127.0.0.1' })
    process.stdout.write((opts.https ? 'https' : 'http') + '://127.0.0.1:' + app.server.address().port + '\\n')
    process.on('SIGTERM', () => { app.close().then(() => process.exit(0)) })
  JS

  module_function

  # The station's chain is the vault's own provider, built here: this port's
  # station has no minivault kind to name in station.json.
  def live(sdk, tokens, accounts)
    dir = Dir.mktmpdir('likeness-wire-')
    DIRS << dir
    file = File.join(dir, 'likeness.skmv')
    vault = VoxgigSekreto.createvault('file' => file, 'passphrase' => PASSPHRASE, 'iterations' => 1000)
    tokens.each { |name, value| vault.set(name, value) }
    vault.close
    provider = VoxgigSekreto.minivaultprovider('file' => file, 'passphrase' => PASSPHRASE)
    station = Likeness.open_station({ 'station' => 1, 'profiles' => { 'default' => {
                                      'secrets' => { 'providers' => [provider] }, 'sdk' => sdk,
                                    } } })
    Bound.new(station: station, calls: Likeness::Calls.new(station),
              conns: Likeness.connections_of(station, accounts, 'default'))
  end

  # A mock in its own process, stopped by its pid when the suite ends.
  def mock(opts)
    out, writer = IO.pipe
    env = { 'LIKENESS_MOCK_URL' => URI::File.build(path: File.join(Harness::ROOT, 'mock', 'server.js')).to_s,
            'LIKENESS_MOCK_OPTS' => JSON.generate(opts) }
    pid = Process.spawn(env, 'node', '--input-type=module', '-e', SERVER, out: writer)
    writer.close
    Minitest.after_run do
      Process.kill('TERM', pid)
      Process.wait(pid)
    rescue Errno::ESRCH, Errno::ECHILD
      nil
    end
    base = Timeout.timeout(30) { out.gets.to_s.strip }
    raise "the mock did not start: #{base.inspect}" unless %r{\Ahttps?://127\.0\.0\.1:\d+\z}.match?(base)

    base
  end

  # The control plane, verified against `ca` where the mock serves TLS.
  def control(base, verb, path, ca = nil)
    uri = URI("#{base}#{path}")
    http = Net::HTTP.new(uri.host, uri.port, nil)
    if 'https' == uri.scheme
      http.use_ssl = true
      http.verify_mode = OpenSSL::SSL::VERIFY_PEER
      http.cert_store = OpenSSL::X509::Store.new.tap { |store| store.add_cert(ca) }
    end
    http.start { |h| JSON.parse(h.request(Net::HTTPGenericRequest.new(verb, false, true, uri)).body) }
  end

  # The mock's request ring for one source, in the order the requests came.
  def rows(base, source, ca = nil)
    control(base, 'GET', "/__requests?source=#{source}", ca)
  end

  def clear(base, ca = nil)
    control(base, 'DELETE', '/__requests', ca)
  end
end
