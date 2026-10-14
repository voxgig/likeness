# frozen_string_literal: true

require_relative 'harness'

class UnitCorpusTest < Minitest::Test
  REGISTRY = {
    'serialise' => ->(v) { Likeness.serialise(v) },
    'parseSelector' => ->(s) { Likeness.parse_selector(s) },
    'parseSelectorError' => lambda { |s|
      begin
        Likeness.parse_selector(s)
      rescue Likeness::SelectorError => e
        next { 'offset' => e.offset, 'token' => e.token }
      end
      raise 'expected a SelectorError and the selector parsed cleanly'
    },
    # The sign is the contract, the magnitude is not.
    'compareCodePoints' => ->((a, b)) { Likeness.compare_code_points(a, b) <=> 0 },
    'lid' => ->(v) { Likeness.lid(*v) },
    'rfc3339' => ->(ms) { Likeness.rfc3339(ms) },
    'crockfordAlphabet' => ->(_) { Likeness::CROCKFORD },
    'foldCase' => ->(s) { Likeness.fold_case(s) },
    'takeConfigOption' => ->(argv) { Likeness.take_config_option(argv) },
    'parseArgv' => ->(argv) { Likeness.parse_argv(argv) },
    'connections' => lambda { |v|
      station = Likeness.open_station(Likeness.parse_station(v['station'], 'station.json'))
      Likeness.connections_of(station, Likeness.parse_accounts(v['likeness'], 'likeness.json'))
              .map { |c| { 'instance' => c.instance, 'source' => c.source, 'account' => c.account } }
    },
    'projectJoplin' => ->(v) { Likeness::Joplin.project(v['raw'], v['instance'], v['account'], false) },
    'partialCodes' => ->(_) { Likeness.partial_codes },
    'vaultEntry' => lambda { |v|
      entry = Likeness.vault_entry(v['station'], profile: v['profile'] || 'default', home: '/home/u',
                                                 dir: '/home/u/.config/likeness', key: v['key'])
      entry.to_h.transform_keys(&:to_s)
    },
  }.freeze

  ALL = Harness.entries('unit')

  def test_the_unit_corpus_is_not_empty
    refute_empty ALL, 'spec/unit.json has no entries - did `make spec-build` run?'
  end

  def test_every_corpus_id_is_unique
    ids = ALL.map { |e| e['id'] }
    assert_equal [], ids.select { |id| ids.count(id) > 1 }.uniq, 'duplicate corpus ids'
  end

  # Read as written: a corpus integer is an Integer here, never a Float.
  def test_corpus_numbers_are_exact
    ALL.select { |e| 'rfc3339' == e['fn'] }.each do |e|
      assert_kind_of Integer, e['in'], e['id']
    end
  end

  ALL.each do |e|
    define_method("test_unit #{e['id']}") do
      fn = REGISTRY[e['fn']]
      refute_nil fn, "no such function in the registry: #{e['fn']}"

      # `err` INSTEAD OF `out`, never alongside it: the shape refuses both.
      if e.key?('err')
        thrown = assert_raises(StandardError) { fn.call(e['in']) }
        assert_includes thrown.message, e['err']
      else
        assert_equal e['out'], fn.call(e['in'])
      end
    end
  end
end
