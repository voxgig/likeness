# frozen_string_literal: true

require 'open3'
require 'rbconfig'
require 'tmpdir'

require_relative 'harness'

# One process loads three generated SDKs that each define their names at the
# top level. What they share, and why none of it changes what likeness runs.
class SDKsTest < Minitest::Test
  ROOTS = %w[joplin-sdk notion-sdk obsidian-sdk].to_h do |sdk|
    [sdk, File.realpath(File.join(Likeness::VENDOR, sdk, 'rb'))]
  end.freeze

  # The entity each adapter reads, by the SDK that must define it alone.
  READ = { 'joplin-sdk' => 'NoteEntity', 'notion-sdk' => 'PageEntity', 'obsidian-sdk' => 'VaultEntity' }.freeze

  LIB = File.join(Harness::ROOT, 'ruby', 'lib')

  def shipped(root)
    Dir.glob('**/*.rb', base: root).reject { |f| f.start_with?('test/') }
  end

  def text(path)
    File.read(path, encoding: 'UTF-8')
  end

  def code(path)
    text(path).lines.reject { |line| line.lstrip.start_with?('#') }.join
  end

  # The top-level names an SDK's shipped files declare.
  def declared(root)
    shipped(root).flat_map do |rel|
      text(File.join(root, rel)).lines.filter_map do |line|
        line[/\A(?:class|module)\s+([A-Z]\w*)/, 1] || line[/\A([A-Z]\w*)\s*=/, 1]
      end
    end.uniq
  end

  def shared
    ROOTS.values.flat_map { |root| declared(root) }.tally.select { |_, n| n > 1 }.keys.sort
  end

  def typed?(name)
    ROOTS.values.any? do |root|
      Dir.glob('*_types.rb', base: root).any? { |f| text(File.join(root, f)).match?(/^#{name}\s*=/) }
    end
  end

  def test_the_names_the_sdks_share_are_the_struct_two_typed_models_and_one_entity
    assert_equal %w[Tag TagEntity TagListMatch VoxgigStruct], shared
  end

  def test_every_sdk_carries_the_same_voxgig_struct
    copies = ROOTS.values.map { |root| File.binread(File.join(root, Likeness::SDKLoad::STRUCT)) }
    assert_equal 1, copies.uniq.length, 'the SDKs vendor different copies of VoxgigStruct'
  end

  def test_each_entity_likeness_reads_is_defined_by_its_own_sdk_alone
    READ.each do |sdk, name|
      ROOTS.reject { |s, _| s == sdk }.each_value do |root|
        refute_includes declared(root), name, "#{name} is declared by #{root} too"
      end
    end
    { 'joplin-sdk' => JoplinSDK.test({}).Note, 'notion-sdk' => NotionSDK.test({}).Page,
      'obsidian-sdk' => ObsidianSDK.test({}).Vault }.each do |sdk, entity|
      assert_equal READ[sdk], entity.class.name
      files = entity.class.instance_methods(false).map { |m| entity.class.instance_method(m).source_location.first }
      assert_equal [File.join(ROOTS[sdk], 'entity')], files.map { |f| File.dirname(File.realpath(f)) }.uniq
    end
  end

  # A typed model is built by an SDK's caller: no SDK code and no adapter builds one.
  def test_no_sdk_and_no_adapter_reads_a_shared_typed_model
    typed = shared.select { |name| typed?(name) }
    assert_equal %w[Tag TagListMatch], typed
    use = /(?<![\w:"'.])(?:#{typed.join('|')})(?:\.|::|\[)/
    Dir.glob('**/*.rb', base: LIB).each { |rel| refute use.match?(code(File.join(LIB, rel))), rel }
    ROOTS.each_value do |root|
      shipped(root).reject { |f| f.end_with?('_types.rb') }.each do |rel|
        refute use.match?(code(File.join(root, rel))), "#{root}/#{rel}"
      end
    end
  end

  # The entity two SDKs share is built only by each one's own facade, which no adapter calls.
  def test_the_shared_entity_is_reached_only_through_a_facade_no_adapter_calls
    entity = shared.select { |name| name.end_with?('Entity') }
    assert_equal %w[TagEntity], entity
    facade = entity.map { |name| name.delete_suffix('Entity') }
    reach = /\b(?:#{entity.join('|')})\b|\.(?:#{facade.join('|')})\b/
    Dir.glob('**/*.rb', base: LIB).each { |rel| refute reach.match?(code(File.join(LIB, rel))), rel }
  end

  def test_a_command_across_the_three_sources_never_loads_the_entity_they_share
    ids = %w[sources/list-across-three-sources sources/get-across-three-sources sources/doctor-across-three-sources]
    script = <<~RUBY
      require_relative #{File.join(Harness::ROOT, 'ruby', 'test', 'harness').inspect}
      exits = #{ids.inspect}.map do |id|
        Likeness.run(Harness.build_ctx(Harness.entries('cli').find { |e| e['id'] == id })).exit
      end
      puts "\#{exits.inspect} \#{defined?(TagEntity).inspect}"
    RUBY
    out, err, status = Open3.capture3(RbConfig.ruby, '-I', LIB, '-e', script)
    assert status.success?, err
    assert out.start_with?("[2, 0, 0] nil\n"), out
    assert_equal '', err
  end

  def test_a_struct_that_differs_from_the_one_loaded_is_refused_before_it_loads
    Dir.mktmpdir('likeness-') do |root|
      copy = File.join(root, Likeness::SDKLoad::STRUCT)
      FileUtils.mkdir_p(File.dirname(copy))
      File.write(copy, "#{File.read(File.join(ROOTS['joplin-sdk'], Likeness::SDKLoad::STRUCT))}\n")
      err = assert_raises(LoadError) { Likeness::SDKLoad.same_struct!(root) }
      assert_match(/differs from the VoxgigStruct already loaded/, err.message)
    end
  end

  def warning(sdk, rel, line, text)
    "#{File.join(ROOTS[sdk], rel)}:#{line}: warning: #{text}\n"
  end

  def test_the_loader_drops_only_a_redefinition_proven_inert
    struct = Likeness::SDKLoad::STRUCT
    load = Likeness::SDKLoad
    assert load.dropped?(warning('notion-sdk', struct, 6, 'already initialized constant VoxgigStruct::DEBUG'),
                         warning('joplin-sdk', struct, 6, 'previous definition of DEBUG was here'))
    assert load.dropped?(warning('obsidian-sdk', 'Obsidian_types.rb', 454, 'already initialized constant Tag'),
                         warning('joplin-sdk', 'Joplin_types.rb', 458, 'previous definition of Tag was here'))
    refute load.dropped?(warning('obsidian-sdk', struct, 588, 'method redefined; discarding old joinurl'),
                         warning('obsidian-sdk', struct, 493, 'previous definition of joinurl was here'))
    refute load.dropped?(warning('obsidian-sdk', 'entity/tag_entity.rb', 33, 'method redefined; discarding old get_name'),
                         warning('joplin-sdk', 'entity/tag_entity.rb', 33, 'previous definition of get_name was here'))
    refute load.dropped?(warning('notion-sdk', struct, 6, 'already initialized constant VoxgigStruct::DEBUG'),
                         warning('joplin-sdk', struct, 7, 'previous definition of OTHER was here'))
    refute load.dropped?("#{File.join(LIB, 'likeness', 'core.rb')}:1: warning: already initialized constant Likeness::X\n",
                         warning('joplin-sdk', struct, 6, 'previous definition of X was here'))
  end
end
