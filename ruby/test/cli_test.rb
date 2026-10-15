# frozen_string_literal: true

require_relative 'harness'

class CliCorpusTest < Minitest::Test
  ALL = Harness.entries('cli')

  def test_the_transcript_corpus_is_not_empty
    refute_empty ALL, 'spec/cli.json has no entries - did `make spec-build` run?'
  end

  def test_every_corpus_id_is_unique
    ids = ALL.map { |e| e['id'] }
    assert_equal [], ids.select { |id| ids.count(id) > 1 }.uniq, 'duplicate corpus ids'
  end

  def test_no_expectation_file_is_unreferenced
    found = Dir.glob('**/*', base: File.join(Harness::ROOT, 'spec', 'expect')).sort
               .map { |f| "spec/expect/#{f}" }
               .select { |f| File.file?(File.join(Harness::ROOT, f)) }
    used = ALL.map { |e| e['out']['stdout'] }
    assert_equal [], found - used, 'expectation files no entry refers to'
  end

  ALL.each do |e|
    define_method("test_cli #{e['id']}") do
      failures = Harness.check(e)
      assert_empty failures, "#{e['id']}:\n  #{failures.join("\n  ")}"
    end
  end
end
