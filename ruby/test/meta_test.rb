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

  # The control: a harness that fails a correct entry proves nothing by
  # failing a broken one.
  def test_the_unmutated_entry_passes
    assert_equal [], Harness.check(entry('list/all'))
  end

  def test_a_wrong_exit_code_is_reported
    e = entry('list/all')
    e['out']['exit'] = 3
    assert_reported Harness.check(e), 'exit '
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
      assert_reported Harness.check(e), 'stdout differs'
    ensure
      File.delete(tmp)
    end
  end

  def test_a_vault_left_holding_the_wrong_names_is_reported
    e = entry('secrets/remove')
    refute_nil e['out']['vault'], 'secrets/remove asserts no vault state'
    e['out']['vault']['names'] = %w[joplin.apikey notion.apikey]
    assert_reported Harness.check(e), 'vault names '
  end

  def test_a_vault_value_that_differs_is_reported
    e = entry('secrets/set-from-stdin')
    refute_nil e['out']['vault']['values'], 'secrets/set-from-stdin asserts no values'
    e['out']['vault']['values'] = { 'joplin.apikey' => "rotated-token\n" }
    assert_reported Harness.check(e), 'vault value of '
  end

  def test_a_prompt_that_was_not_expected_is_reported
    e = entry('secrets/passphrase-typed')
    e['out']['prompts'] = []
    assert_reported Harness.check(e), 'prompts '
  end

  def test_a_missing_call_is_reported
    e = entry('list/all')
    e['out']['calls'] = []
    assert_reported Harness.check(e), 'calls '
  end

  # A command producing the right answer by making more requests than it
  # should: an entry asserting only stdout would pass it.
  def test_an_extra_call_is_reported
    e = entry('list/all')
    e['out']['calls'] << { 'instance' => 'joplin', 'method' => 'GET', 'path' => '/notes' }
    assert_reported Harness.check(e), 'calls '
  end

  def test_a_call_with_the_right_count_but_the_wrong_path_is_reported
    e = entry('list/all')
    e['out']['calls'] = [{ 'instance' => 'joplin', 'method' => 'GET', 'path' => '/folders' }]
    assert_reported Harness.check(e), 'calls '
  end

  def test_unexpected_stderr_is_reported
    e = entry('list/all')
    e['out']['stderr'] = "something the command never printed\n"
    assert_reported Harness.check(e), 'stderr '
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
    failures = Harness.check(e)
    assert_equal 3, failures.length, "expected three failures, got #{failures.inspect}"
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

  def test_net_options_reach_the_sdk
    seed = { 'entity' => { 'note' => { 'x1' => { 'id' => 'x1' } } },
             'net' => { 'failTimes' => 1, 'failStatus' => 401 } }
    r = Likeness::Joplin.check(JoplinSDK.test(seed))
    assert_equal({ ok: false, code: 'auth-failed', detail: 'the token was rejected' }, r)
  end
end
