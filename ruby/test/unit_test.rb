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
      env = v.key?('profile') ? { 'VOXGIG_STATION_PROFILE' => v['profile'] } : nil
      profile = Likeness.profile_of(env)
      station = Likeness.open_station(Likeness.parse_station(v['station'], 'station.json'), env)
      Likeness.connections_of(station, Likeness.parse_accounts(v['likeness'], 'likeness.json', profile), profile)
              .map { |c| { 'instance' => c.instance, 'source' => c.source, 'account' => c.account } }
    },
    'projectJoplin' => ->(v) { Likeness::Joplin.project(v['raw'], v['instance'], v['account'], false) },
    'partialCodes' => ->(_) { Likeness.partial_codes },
    'obsidianUrl' => ->(v) { Likeness::Obsidian.note_url(v['vault'], v['path']) },
    'vaultEntries' => ->(listed) { Likeness::Obsidian.entries(listed) },
    'vaultWalk' => lambda { |v|
      steps = []
      Likeness::Obsidian.walk_steps do |step|
        steps << step
        Likeness::Obsidian.entries(v['listings'][step['list']] || []) if step.key?('list')
      end
      steps
    },
    'obsidianTransport' => ->(v) { Likeness::Obsidian.transport(v['instance'], v['block']) },
    'projectObsidian' => lambda { |v|
      Likeness::Obsidian.project(v['raw'], v['path'], v['instance'], v['account'], false)
    },
    'notionVersion' => ->(v) { Likeness::Notion.configure(v['instance'], v['block']) },
    'notionTitle' => ->(properties) { Likeness::Notion.title_of(properties) },
    # Absent is `{}`: the corpus has no way to say "no value" but an empty record.
    'notionSpace' => lambda { |parent|
      space = Likeness::Notion.space_of(parent)
      space.nil? ? {} : { 'space' => space }
    },
    'notionTime' => ->(v) { Likeness::Notion.stamp(v, 'created_time') },
    'projectNotion' => ->(v) { Likeness::Notion.project(v['raw'], v['instance'], v['account'], false) },
    'parsePin' => ->(text) { Likeness.parse_pin(text) },
    'fingerprintOf' => ->(hex) { Likeness.fingerprint_of([hex].pack('H*')) },
    'secretName' => ->(ref) { Likeness.secret_name(ref) },
    'refFor' => ->(v) { Likeness.ref_for(v['source'], v['instance']) },
    'vaultEntry' => lambda { |v|
      entry = Likeness.vault_entry(v['station'], profile: v['profile'] || 'default', home: '/home/u',
                                                 dir: '/home/u/.config/likeness', key: v['key'])
      entry.to_h.transform_keys(&:to_s)
    },
  }.freeze

  # The answer as canonical JSON reads it back, so `true` and `1` stay
  # different answers and a value compares as the JSON it prints as.
  def self.plain(fn)
    ->(v) { JSON.parse(Likeness.serialise(fn.call(v))) }
  end

  UNIT = VoxgigOmni.make_runner(File.join(Harness::ROOT, 'spec', 'unit.json'),
                                { subject: ->(name) { REGISTRY.key?(name) ? plain(REGISTRY[name]) : nil } })
                   .call('unit')

  ALL = Harness.entries('unit')

  def test_the_unit_corpus_is_not_empty
    refute_empty ALL, 'spec/unit.json has no entries - did `make spec-build` run?'
  end

  def test_every_corpus_id_is_unique
    ids = ALL.map { |e| e['id'] }
    assert_equal [], ids.select { |id| ids.count(id) > 1 }.uniq, 'duplicate corpus ids'
  end

  def test_every_function_the_corpus_names_is_registered
    assert_equal [], ALL.map { |e| e['fn'] }.uniq.sort - REGISTRY.keys
  end

  # Read as written: a corpus integer is an Integer here, never a Float.
  def test_corpus_numbers_are_exact
    ALL.select { |e| 'rfc3339' == e['fn'] }.each do |e|
      assert_kind_of Integer, e['in'], e['id']
    end
  end

  UNIT[:spec].keys.sort.each do |name|
    define_method("test_unit #{name}") do
      UNIT[:runsetflags].call(UNIT[:spec][name], { null: false, all: true })
    end
  end
end
