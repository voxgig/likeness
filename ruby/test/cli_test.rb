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

  # spec/written holds the files a command writes, as spec/expect holds what it prints.
  def test_no_expectation_file_is_unreferenced
    found = %w[expect written].flat_map do |dir|
      Dir.glob('**/*', base: File.join(Harness::ROOT, 'spec', dir)).sort.map { |f| "spec/#{dir}/#{f}" }
    end
    found = found.select { |f| File.file?(File.join(Harness::ROOT, f)) }
    used = ALL.flat_map { |e| [e['out']['stdout'], *(e['out']['files'] || {}).values] }
    assert_equal [], found - used, 'expectation files no entry refers to'
  end

  def test_every_entry_waiting_upstream_is_in_the_corpus
    assert_equal [], Harness::WAITING.keys - ALL.map { |e| e['id'] }
  end

  SPEC = Harness.corpus('cli')

  SPEC.keys.sort.each do |name|
    define_method("test_cli #{name}") do
      ids = SPEC[name]['set'].map { |e| e['id'] }
      waits = Harness::WAITING.slice(*ids).transform_values { |(cause, _)| { 'cause' => cause } }
      Harness.run_group(name, SPEC[name]['set'], { null: false, all: true, wait: waits })
    end
  end

  # A wait holds an entry only while it fails; this holds it to failing for
  # its declared cause alone, so the declaration cannot hide a second
  # difference.
  unless Harness::WAITING.empty?
    define_method('test_cli waiting entries differ only as their cause predicts') do
      waiting = ALL.select { |e| Harness::WAITING.key?(e['id']) }
      predicted = waiting.map { |e| Harness::WAITING[e['id']][1].call(e) }
      Harness.run_group('predicted', predicted, { null: false, all: true })
    end
  end
end
