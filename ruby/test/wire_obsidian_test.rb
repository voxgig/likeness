# frozen_string_literal: true

require 'socket'

require_relative 'cert'
require_relative 'live'

# The Obsidian adapter's real transport, pinned, against mock/ over TLS with
# certificates made here.
class WireObsidianTest < Minitest::Test
  # The plugin's credential, as the mock reads it from its seed.
  TOKEN = 'obsidian-local-rest-api-key-0001'
  ACCOUNT = 'wirevault000001'

  CERT = Cert.self_signed
  OTHER = Cert.self_signed

  GET = { 'method' => 'GET', 'headers' => { 'authorization' => "Bearer #{TOKEN}" } }.freeze

  Bound = Struct.new(:station, :calls, :conn, :handle, keyword_init: true)

  class << self
    def secure
      @secure ||= Live.mock('sources' => ['obsidian'], 'https' => { 'key' => CERT.key, 'cert' => CERT.cert })
    end

    def plain
      @plain ||= Live.mock('sources' => ['obsidian'])
    end
  end

  def secure
    self.class.secure
  end

  def plain
    self.class.plain
  end

  def pinned(to)
    { 'base' => "#{secure}/obsidian", 'options' => { 'tls' => { 'fingerprint' => Likeness.fingerprint_of(to.der) } } }
  end

  # A client bound through station, its token resolved from the vault.
  def bound(block, token = TOKEN)
    l = Live.live({ 'obsidian' => block }, { 'obsidian.apikey' => token }, { 'obsidian' => ACCOUNT })
    conn = l.conns[0]
    handle = Likeness::Obsidian.connect(l.station, conn, Likeness::Obsidian.configure(conn.instance, block))
    Bound.new(station: l.station, calls: l.calls, conn: conn, handle: handle)
  end

  def secure_rows
    Live.rows(secure, 'obsidian', CERT.x509)
  end

  def assert_refused(&run)
    err = assert_raises(Likeness::LikenessError, &run)
    assert_equal 'certificate-rejected', err.code
  end

  # What station observed is what the mock received, in order, and the token never reached an event.
  def assert_observed(bound, seen)
    assert_equal(seen.map { |r| "#{r['method']} #{r['url']}" }, bound.calls.all.map { |c| "#{c['method']} #{c['path']}" })
    refute_includes JSON.generate(bound.station.events), TOKEN, 'the token reached an event'
  end

  def test_a_pinned_connection_walks_the_vault_reading_each_note_as_note_json_with_the_vaults_token
    listed = bound(pinned(CERT)).handle.sdk.Vault.list.map { |e| Likeness::Obsidian.data(e) }
    if !listed.empty? && listed.all?({})
      skip "this port's SDK keeps no name of a listing that names its entries as text, so a live vault " \
           'cannot be walked from its root until the SDK keeps them'
    end

    Live.clear(secure, CERT.x509)
    b = bound(pinned(CERT))
    got = Likeness::Obsidian.list_notes(b.handle, b.conn, false)
    assert_equal false, got[:more]
    assert_equal %w[mydocument.md projects/nested/deep-note.md somedirectory/meeting-notes.md
                    somedirectory/roadmap.md welcome.md], got[:notes].map { |n| n['id'] }.sort
    seen = secure_rows
    reads = seen.select { |r| r['url'].end_with?('.md') }
    assert_equal got[:notes].length, reads.length
    reads.each { |r| assert_equal Likeness::Obsidian::NOTE_JSON, r['headers']['accept'], r['url'] }
    seen.each { |r| assert_equal 'ok', r['auth'], r['url'] }
    assert_observed(b, seen)
  end

  def test_a_pinned_connection_reads_a_directory_and_its_notes_as_note_json_with_the_vaults_token
    Live.clear(secure, CERT.x509)
    b = bound(pinned(CERT))
    notes = []
    Likeness::Obsidian.walk_steps('somedirectory/') do |step|
      next Likeness::Obsidian.listing(b.handle, step['list']) if step.key?('list')

      notes << Likeness::Obsidian.read(b.handle, b.conn, step['read'], false)
      nil
    end
    assert_equal [['somedirectory/meeting-notes.md', 'meeting-notes', 'somedirectory'],
                  ['somedirectory/roadmap.md', 'roadmap', 'somedirectory']],
                 notes.map { |n| [n['id'], n['title'], n['space']] }
    seen = secure_rows
    assert_equal ['/obsidian/vault/somedirectory%2F', '/obsidian/vault/somedirectory%2Fmeeting-notes.md',
                  '/obsidian/vault/somedirectory%2Froadmap.md'], seen.map { |r| r['url'] }
    seen.drop(1).each { |r| assert_equal Likeness::Obsidian::NOTE_JSON, r['headers']['accept'], r['url'] }
    seen.each { |r| assert_equal [200, 'ok'], [r['status'], r['auth']], r['url'] }
    assert_observed(b, seen)
  end

  def test_a_note_read_without_the_note_json_accept_is_markdown_which_the_client_cannot_read
    Live.clear(secure, CERT.x509)
    l = Live.live({ 'obsidian' => pinned(CERT) }, { 'obsidian.apikey' => TOKEN }, { 'obsidian' => ACCOUNT })
    bare = l.station.connect(ObsidianSDK, 'utility' => { 'fetcher' => Likeness::Pin.fetcher(Likeness.fingerprint_of(CERT.der)) },
                                          'feature' => { 'station' => { 'instance' => 'obsidian' } })
    assert_raises(StandardError) { bare.Vault.load({ 'id' => 'welcome.md' }) }
    row = secure_rows.first
    assert_equal [200, 'ok', 'application/json'], [row['status'], row['auth'], row['headers']['accept']]

    b = bound(pinned(CERT))
    assert_equal 'welcome', Likeness::Obsidian.load_note(b.handle, b.conn, 'welcome.md', false)['title']
  end

  def test_a_changed_certificate_is_refused_before_any_request_reaches_the_plugin
    Live.clear(secure, CERT.x509)
    b = bound(pinned(OTHER))
    assert_refused { Likeness::Obsidian.list_notes(b.handle, b.conn, false) }
    assert_refused { Likeness::Obsidian.load_note(b.handle, b.conn, 'welcome.md', false) }
    assert_equal 'certificate-rejected', Likeness::Obsidian.check(b.handle)[:code]
    assert_equal [], secure_rows
  end

  def test_plain_http_is_used_where_the_connection_declares_it_and_doctor_says_so
    Live.clear(plain)
    b = bound({ 'base' => "#{plain}/obsidian", 'options' => { 'tls' => false } })
    assert_equal({ ok: true, detail: 'ok, over plain HTTP as the connection declares' }, Likeness::Obsidian.check(b.handle))
    assert_equal ['ok'], Live.rows(plain, 'obsidian').map { |r| r['auth'] }
  end

  def test_a_wrong_token_is_auth_failed_and_an_absent_plugin_is_source_unavailable_with_its_remedy
    assert_equal 'auth-failed', Likeness::Obsidian.check(bound(pinned(CERT), 'not-the-token').handle)[:code]

    gone = { 'base' => 'https://127.0.0.1:1/obsidian',
             'options' => { 'tls' => { 'fingerprint' => Likeness.fingerprint_of(CERT.der) } } }
    r = Likeness::Obsidian.check(bound(gone).handle)
    assert_equal 'source-unavailable', r[:code]
    assert_match(/start Obsidian with the Local REST API/, r[:remedy])
  end

  def context(throwaway)
    OpenSSL::SSL::SSLContext.new.tap do |ctx|
      ctx.cert = throwaway.x509
      ctx.key = throwaway.pkey
    end
  end

  # A TLS server answering each connection on a thread of its own, the first
  # with `first`'s certificate and the rest with `later`'s. It counts, per
  # connection accepted, the application bytes `serve` reports reading.
  def tls_server(first, later = nil, &serve)
    tcp = TCPServer.new('127.0.0.1', 0)
    contexts = [context(first), context(later || first)]
    bytes = []
    threads = []
    acceptor = Thread.new do
      loop do
        raw = tcp.accept
        index = bytes.length
        bytes << 0
        threads << Thread.new do
          ssl = OpenSSL::SSL::SSLSocket.new(raw, contexts[index.zero? ? 0 : 1])
          ssl.accept
          serve.call(ssl, ->(n) { bytes[index] += n })
        rescue StandardError
          nil
        ensure
          raw.close unless raw.closed?
        end
      end
    rescue IOError, SystemCallError
      nil
    end
    stop = lambda do
      tcp.close
      acceptor.join(5)
      threads.each { |t| t.join(5) || t.kill }
    end
    [tcp.addr[1], bytes, stop]
  end

  # The application bytes each connection received, and what the pinned fetch made of it.
  def served(first, later, pin, host = '127.0.0.1')
    port, bytes, stop = tls_server(first, later) do |ssl, count|
      count.call(ssl.readpartial(65_536).bytesize)
      ssl.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
    end
    begin
      res, err = Likeness::Pin.fetcher(pin).call({}, "https://#{host}:#{port}/vault/", GET)
      raise "the fetch failed: #{err}" unless err.nil?

      { 'status' => res['status'], 'bytes' => bytes.dup }
    rescue Likeness::CertificateError => e
      { 'refusal' => e.refusal, 'bytes' => bytes.dup }
    ensure
      stop.call
    end
  end

  def test_no_request_byte_is_written_before_the_certificate_has_matched_the_pin
    # The probe that learns the certificate writes nothing; the request goes on
    # the connection that verified it.
    right = served(CERT, nil, Likeness.fingerprint_of(CERT.der))
    assert_equal 200, right['status']
    assert_equal 2, right['bytes'].length
    assert_equal 0, right['bytes'][0]
    assert_operator right['bytes'][1], :>, 0

    assert_equal({ 'refusal' => 'changed', 'bytes' => [0] }, served(CERT, nil, Likeness.fingerprint_of(OTHER.der)))

    # A certificate swapped after the probe is caught by the verified connection.
    assert_equal({ 'refusal' => 'changed', 'bytes' => [0, 0] }, served(CERT, OTHER, Likeness.fingerprint_of(CERT.der)))

    old = Cert.self_signed([-3, -1])
    assert_equal({ 'refusal' => 'expired', 'bytes' => [0, 0] }, served(old, nil, Likeness.fingerprint_of(old.der)))
  end

  # The pin replaces the trust anchor and not the host check, which Net::HTTP
  # makes of an address once the handshake is done and OpenSSL of a name during it.
  def test_a_pinned_certificate_for_another_address_is_refused_before_any_byte
    elsewhere = Cert.self_signed(address: '127.0.0.2')
    assert_equal({ 'refusal' => 'wrong-host', 'bytes' => [0, 0] },
                 served(elsewhere, nil, Likeness.fingerprint_of(elsewhere.der)))
  end

  def test_a_pinned_certificate_for_an_address_is_refused_for_a_name_before_any_byte
    unless '127.0.0.1' == Addrinfo.getaddrinfo('localhost', nil, nil, :STREAM).first&.ip_address
      skip 'localhost is not 127.0.0.1 here'
    end

    assert_equal({ 'refusal' => 'wrong-host', 'bytes' => [0, 0] },
                 served(CERT, nil, Likeness.fingerprint_of(CERT.der), 'localhost'))
  end

  def test_a_pinned_request_closes_its_connection_once_the_response_is_read
    closed = Queue.new
    port, _bytes, stop = tls_server(CERT) do |ssl, _count|
      ssl.readpartial(65_536)
      ssl.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nkeep-alive: timeout=60\r\n\r\n{}")
      ssl.readpartial(65_536)
    rescue IOError, SystemCallError, OpenSSL::SSL::SSLError
      closed << true
    end
    begin
      res, err = Likeness::Pin.fetcher(Likeness.fingerprint_of(CERT.der))
                                .call({}, "https://127.0.0.1:#{port}/vault/",
                                      { 'method' => 'GET', 'headers' => { 'connection' => 'keep-alive' } })
      assert_nil err
      assert_equal '{}', res['body']
      refute_nil closed.pop(timeout: 5), 'a connection was left open'
    ensure
      stop.call
    end
  end

  def test_the_adapter_reaches_a_vault_through_the_plugin_alone_never_its_files
    %w[ruby/lib/likeness/adapter/obsidian.rb ruby/lib/likeness/pin.rb].each do |file|
      refute_match(/\b(?:File|Dir|IO|FileUtils|Pathname)\b|require ['"](?:fileutils|pathname)['"]/,
                   Harness.read(file), file)
    end
  end
end
