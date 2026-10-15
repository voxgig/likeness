# frozen_string_literal: true

require 'net/http'
require 'timeout'
require 'uri'

require_relative 'harness'

# The adapter's real transport against mock/, for what the offline mode cannot
# show: the query it sends.
class WireTest < Minitest::Test
  APIKEY = 'joplin-mock-token'
  EPOCH = '1970-01-01T00:00:00Z'
  CONN = Likeness::Connection.new(instance: 'joplin', source: 'joplin', account: 'local')

  class << self
    attr_accessor :root
  end

  # One mock for the suite, on a port the OS chose.
  def self.mock_root
    self.root ||= begin
      out, writer = IO.pipe
      pid = Process.spawn({ 'LIKENESS_MOCK_PORT' => '0' }, 'node', File.join(Harness::ROOT, 'mock', 'server.js'),
                          out: writer)
      writer.close
      Minitest.after_run do
        Process.kill('TERM', pid)
        Process.wait(pid)
      end
      Timeout.timeout(30) do
        line = out.gets until line.to_s.include?('listening on')
        line[%r{http://\S+}]
      end
    end
  end

  def mock(verb, path)
    uri = URI("#{self.class.mock_root}#{path}")
    Net::HTTP.start(uri.host, uri.port) do |http|
      res = http.request(Net::HTTPGenericRequest.new(verb, false, true, uri))
      JSON.parse(res.body)
    end
  end

  # A client straight to the mock, outside station: station's request events
  # do not carry the query, which is what these assert.
  def client
    JoplinSDK.new('apikey' => APIKEY, 'base' => "#{self.class.mock_root}/joplin")
  end

  def fields_sent
    mock('GET', '/__requests?source=joplin').map do |r|
      URI.decode_www_form(URI(r['url']).query.to_s).to_h['fields']
    end
  end

  def test_list_asks_for_the_fields_the_shape_needs_and_gets_real_timestamps_back
    mock('DELETE', '/__requests')
    notes = Likeness::Joplin.list_notes(client, CONN, false)[:notes]
    assert_equal [Likeness::Joplin::FIELDS], fields_sent
    refute_empty notes
    notes.each do |n|
      refute_equal EPOCH, n['created'], "#{n['id']} created"
      refute_equal EPOCH, n['updated'], "#{n['id']} updated"
      assert_kind_of String, n['body'], "#{n['id']} body"
    end
  end

  def test_without_fields_the_mock_answers_the_three_joplin_defaults_which_project_to_the_epoch
    rows = client.Note.list({}).map { |e| Likeness::Joplin.data(e) }
    refute_empty rows
    rows.each do |r|
      assert_equal %w[id parent_id title], r.keys.sort
      n = Likeness::Joplin.project(r, 'joplin', 'local', false)
      assert_equal EPOCH, n['created']
      refute n.key?('body')
    end
  end

  def test_load_and_check_ask_for_the_fields_too
    mock('DELETE', '/__requests')
    n = Likeness::Joplin.load_note(client, CONN, 'a0e50000000000000000000000000001', false)
    refute_nil n
    assert_kind_of String, n['body']
    refute_equal EPOCH, n['created']
    r = Likeness::Joplin.check(client)
    assert r[:ok], r[:detail]
    assert_equal [Likeness::Joplin::FIELDS, Likeness::Joplin::FIELDS], fields_sent
  end
end
