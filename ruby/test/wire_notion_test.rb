# frozen_string_literal: true

require_relative 'live'

# The Notion adapter's real transport, bound through station, against mock/.
class WireNotionTest < Minitest::Test
  # The integration token, as the mock reads it from its seed.
  TOKEN = 'secret_TOKEN'
  ACCOUNT = 'wireworkspace01'
  VERSION = '2022-06-28'
  PAGE = '2a9e0000-0000-4000-8000-000000000002'

  Bound = Struct.new(:station, :calls, :conn, :handle, keyword_init: true)

  def self.server
    @server ||= Live.mock('sources' => ['notion'])
  end

  def server
    self.class.server
  end

  def block(version = VERSION)
    { 'base' => "#{server}/notion/v1", 'options' => { 'headers' => { 'notion-version' => version } } }
  end

  # A client bound through station, its token resolved from the vault.
  def bound(token = TOKEN)
    l = Live.live({ 'notion' => block }, { 'notion.apikey' => token }, { 'notion' => ACCOUNT })
    conn = l.conns[0]
    handle = Likeness::Notion.connect(l.station, conn, Likeness::Notion.configure(conn.instance, block))
    Bound.new(station: l.station, calls: l.calls, conn: conn, handle: handle)
  end

  def rows
    Live.rows(server, 'notion')
  end

  def test_a_page_is_read_with_the_pinned_notion_version_and_the_vaults_token
    Live.clear(server)
    b = bound
    note = Likeness::Notion.load_note(b.handle, b.conn, PAGE, false)
    assert_equal [PAGE, 'Ship the SDK', '7b3d0000-0000-4000-8000-000000000001',
                  'https://www.notion.so/Ship-the-SDK-2a9e0000000040008000000000000002'],
                 note.values_at('id', 'title', 'space', 'url')
    seen = rows
    assert_equal [['GET', "/notion/v1/pages/#{PAGE}", 200, 'ok', VERSION]],
                 seen.map { |r| [r['method'], r['url'], r['status'], r['auth'], r['headers']['notion-version']] }
    assert_equal(seen.map { |r| "#{r['method']} #{r['url']}" }, b.calls.all.map { |c| "#{c['method']} #{c['path']}" })
    refute_includes JSON.generate(b.station.events), TOKEN, 'the token reached an event'
  end

  def test_doctors_check_reaches_a_page_no_workspace_holds_which_only_an_accepted_request_finds_missing
    Live.clear(server)
    assert_equal({ ok: true, detail: 'ok' }, Likeness::Notion.check(bound.handle))
    assert_equal [["/notion/v1/pages/#{Likeness::Notion::NO_PAGE}", 404, 'ok', VERSION]],
                 rows.map { |r| [r['url'], r['status'], r['auth'], r['headers']['notion-version']] }
  end

  def test_a_client_that_sends_no_notion_version_is_refused_as_notion_refuses_it
    Live.clear(server)
    l = Live.live({ 'notion' => block }, { 'notion.apikey' => TOKEN }, { 'notion' => ACCOUNT })
    bare = l.station.connect(Likeness::Notion::SDK, 'feature' => { 'station' => { 'instance' => 'notion' } })
    err = assert_raises(StandardError) { bare.Page.load({ 'id' => PAGE }) }
    assert_equal 400, Likeness.status_of(err)
    row = rows.first
    assert_equal [400, 'ok', nil], [row['status'], row['auth'], row['headers']['notion-version']]
  end

  def test_a_wrong_token_is_auth_failed
    assert_equal 'auth-failed', Likeness::Notion.check(bound('not-the-token').handle)[:code]
  end

  def test_a_connection_that_pins_no_version_is_refused_before_a_client_exists
    err = assert_raises(Likeness::LikenessError) do
      Likeness::Notion.configure('notion', { 'base' => "#{server}/notion/v1" })
    end
    assert_equal 'invalid-project', err.code
    assert_match(/pins no Notion-Version/, err.message)
  end
end
