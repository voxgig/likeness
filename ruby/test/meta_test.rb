# frozen_string_literal: true

require_relative 'harness'

# The harness proves it can fail. Each test hands it a broken entry, or bytes
# no port produced, and requires the failure to be reported.
class MetaTest < Minitest::Test
  ALL = Harness.entries('cli')

  def entry(id)
    found = ALL.find { |e| e['id'] == id }
    refute_nil found, "no corpus entry with id #{id}"
    Harness.deep_copy(found)
  end

  def assert_reported(failures, prefix)
    assert failures.any? { |f| f.start_with?(prefix) }, "no #{prefix.inspect} failure in #{failures.inspect}"
  end

  def run_entry(id)
    e = entry(id)
    [e, Likeness.run(Harness.build_ctx(e))]
  end

  # The expected and actual results of omni's one result mismatch.
  def sides(failures)
    assert_equal 1, failures.length, failures.inspect
    head, *rest = failures[0].split("\n")
    assert_includes head, 'result mismatch'
    lines = rest.to_h { |line| line[2..].split(':', 2).then { |key, value| [key, value.strip] } }
    [JSON.parse(lines['expected']), JSON.parse(lines['actual'])]
  end

  # The fields the expected and actual results disagree on.
  def differs(failures)
    want, got = sides(failures)
    (want.keys | got.keys).sort.reject { |key| want[key] == got[key] }
  end

  # The control: a harness that fails a correct entry proves nothing by
  # failing a broken one.
  def test_the_unmutated_entry_passes
    assert_equal [], Harness.check(entry('list/all'))
  end

  def test_a_wrong_exit_code_is_reported
    e = entry('list/all')
    e['out']['exit'] = 3
    assert_equal ['exit'], differs(Harness.check(e))
  end

  def test_stdout_differing_by_one_byte_is_reported
    e = entry('list/all')
    text = Harness.read(e['out']['stdout']).sub('Retention', 'Retentiom')
    refute_includes text, 'Retention policy', 'the mutation did not apply'

    rel = 'spec/expect/.meta-rb-one-byte.json'
    tmp = File.join(Harness::ROOT, rel)
    File.write(tmp, text)
    begin
      e['out']['stdout'] = rel
      assert_equal ['stdout'], differs(Harness.check(e))
    ensure
      File.delete(tmp)
    end
  end

  def test_a_vault_left_holding_the_wrong_names_is_reported
    e = entry('secrets/remove')
    refute_nil e['out']['vault'], 'secrets/remove asserts no vault state'
    e['out']['vault']['names'] = %w[joplin.apikey notion.apikey]
    assert_equal ['vault'], differs(Harness.check(e))
  end

  def test_a_vault_value_that_differs_is_reported
    e = entry('secrets/set-from-stdin')
    refute_nil e['out']['vault']['values'], 'secrets/set-from-stdin asserts no values'
    e['out']['vault']['values'] = { 'joplin.apikey' => "rotated-token\n" }
    want, got = sides(Harness.check(e))
    assert_equal want['vault']['names'], got['vault']['names']
    refute_equal want['vault']['values'], got['vault']['values']
  end

  def test_a_prompt_that_was_not_expected_is_reported
    e = entry('secrets/passphrase-typed')
    e['out']['prompts'] = []
    assert_equal ['prompts'], differs(Harness.check(e))
  end

  def test_a_missing_call_is_reported
    e = entry('list/all')
    e['out']['calls'] = []
    assert_equal ['calls'], differs(Harness.check(e))
  end

  # A command producing the right answer by making more requests than it
  # should: an entry asserting only stdout would pass it.
  def test_an_extra_call_is_reported
    e = entry('list/all')
    e['out']['calls'] << { 'instance' => 'joplin', 'method' => 'GET', 'path' => '/notes' }
    assert_equal ['calls'], differs(Harness.check(e))
  end

  def test_a_call_with_the_right_count_but_the_wrong_path_is_reported
    e = entry('list/all')
    e['out']['calls'] = [{ 'instance' => 'joplin', 'method' => 'GET', 'path' => '/folders' }]
    assert_equal ['calls'], differs(Harness.check(e))
  end

  # A waiting entry's prediction admits the one spelling and nothing else.
  def test_a_waiting_entry_as_predicted_still_reports_another_call
    cause, predict = Harness::WAITING.fetch('obsidian/list-odd-values')
    e = predict.call(entry('obsidian/list-odd-values'))
    assert_equal [], Harness.check(e), cause
    e['out']['calls'][-1]['path'] = '/vault/odd%2Felsewhere.md'
    assert_equal ['calls'], differs(Harness.check(e))
  end

  def test_a_waiting_entry_run_without_its_wait_reports_its_calls
    assert_equal ['calls'], differs(Harness.check(entry('obsidian/list-odd-values')))
  end

  def test_a_wait_on_an_entry_that_passes_is_reported
    cause, predict = Harness::WAITING.fetch('obsidian/list-odd-values')
    failures = Harness.check(predict.call(entry('obsidian/list-odd-values')), wait: { 'cause' => cause })
    assert_equal 1, failures.length, failures.inspect
    assert_includes failures[0].lines.first, "stale wait: #{cause}"
  end

  def test_unexpected_stderr_is_reported
    e = entry('list/all')
    e['out']['stderr'] = "something the command never printed\n"
    assert_equal ['stderr'], differs(Harness.check(e))
  end

  def test_a_missing_expectation_file_is_an_error_not_a_pass
    e = entry('list/all')
    e['out']['stdout'] = 'spec/expect/.meta-rb-does-not-exist.json'
    assert_raises(Errno::ENOENT) { Harness.check(e) }
  end

  def test_every_failure_is_reported_not_just_the_first
    e = entry('list/all')
    e['out']['exit'] = 3
    e['out']['calls'] = []
    e['out']['stderr'] = "no\n"
    assert_equal %w[calls exit stderr], differs(Harness.check(e))
  end

  # The bytes are the contract: the right values in the wrong form.
  def test_the_right_values_indented_are_reported
    e, r = run_entry('list/all')
    indented = "#{JSON.pretty_generate(JSON.parse(r.stdout))}\n"
    assert_reported Harness.stdout_failures(e, indented), 'stdout is not in canonical form'
  end

  def test_the_right_values_with_a_crlf_ending_are_reported
    e, r = run_entry('list/all')
    assert_reported Harness.stdout_failures(e, r.stdout.sub(/\n\z/, "\r\n")), 'stdout is not in canonical form'
  end

  def test_an_envelope_naming_another_port_is_reported
    e, r = run_entry('list/all')
    parsed = JSON.parse(r.stdout)
    parsed['port'] = 'ts'
    assert_reported Harness.stdout_failures(e, Likeness.serialise(parsed)), 'envelope port is'
  end

  def test_a_wrong_port_inside_a_which_row_is_reported
    e, r = run_entry('meta/which')
    parsed = JSON.parse(r.stdout)
    refute_empty parsed['data'], 'which produced no rows'
    parsed['data'][0]['port'] = 'WRONG'
    assert_reported Harness.stdout_failures(e, Likeness.serialise(parsed)), 'stdout differs'
  end

  def test_version_reporting_another_port_in_its_data_is_reported
    e, r = run_entry('meta/version')
    parsed = JSON.parse(r.stdout)
    parsed['data']['port'] = 'WRONG'
    assert_reported Harness.stdout_failures(e, Likeness.serialise(parsed)), 'data.port is'
  end

  def test_a_written_file_that_differs_is_reported
    e = entry('connections/add-joplin')
    e['out']['files'] = e['out']['files'].merge('station.json' => 'fixtures/config/several/station.json')
    failures = Harness.check(e)
    assert_equal ['files'], differs(failures)
    want, got = sides(failures)
    refute_equal want['files']['station.json'], got['files']['station.json']
  end

  def test_a_file_the_entry_says_is_not_there_written_is_reported
    e = entry('connections/add-joplin')
    e['out']['absent'] = ['likeness.json']
    failures = Harness.check(e)
    assert_equal ['absent'], differs(failures)
    want, got = sides(failures)
    assert_includes want['absent'], 'likeness.json'
    refute_includes got['absent'], 'likeness.json'
  end

  def test_a_file_the_entry_names_never_written_is_reported
    e = entry('connections/add-joplin-needs-an-account')
    e['out']['files'] = { 'station.json' => 'spec/written/connections/add-joplin/station.json' }
    want, got = sides(Harness.check(e))
    refute_nil want['files']['station.json']
    assert_nil got['files']['station.json']
  end

  def test_net_options_reach_the_sdk
    seed = { 'entity' => { 'note' => { 'x1' => { 'id' => 'x1' } } },
             'net' => { 'failTimes' => 1, 'failStatus' => 401 } }
    r = Likeness::Joplin.check(JoplinSDK.test(seed))
    assert_equal({ ok: false, code: 'auth-failed', detail: 'the token was rejected' }, r)
  end
end
