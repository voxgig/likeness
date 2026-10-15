# frozen_string_literal: true

require 'fileutils'
require 'open3'
require 'openssl'
require 'rbconfig'
require 'socket'
require 'tmpdir'

require_relative 'cert'
require_relative 'harness'

# What the transcript corpus cannot reach: a write that fails part way, a
# symlinked file, the probe on a real TLS server, discovery, and the binary.
class SourcesTest < Minitest::Test
  BIN = File.join(Harness::ROOT, 'ruby', 'bin', 'likeness-rb')
  MASTER = 'fixture master passphrase'
  NOTE = 'a0e50000000000000000000000000001'
  ALL = Harness.entries('cli')
  CONFIG = %w[station.json likeness.json].freeze

  # Ruby's own file operations, but for the nth renames, which fail as a full disk would.
  class Failing
    def initialize(*nth)
      @nth = nth
      @renames = 0
    end

    def write(path, data, mode)
      Likeness::FileOps.write(path, data, mode)
    end

    def rename(from, to)
      @renames += 1
      raise Errno::ENOSPC if @nth.include?(@renames)

      File.rename(from, to)
    end

    def unlink(path)
      Likeness::FileOps.unlink(path)
    end
  end

  def entry(id)
    found = ALL.find { |e| e['id'] == id }
    refute_nil found, "no corpus entry with id #{id}"
    Harness.deep_copy(found)
  end

  def in_folder(files)
    Dir.mktmpdir('likeness-write-') do |dir|
      files.each { |name, text| File.write(File.join(dir, name), text) }
      yield dir
    end
  end

  def was(path)
    Likeness::Held.new(bytes: File.binread(path), mode: File.stat(path).mode & 0o777)
  end

  def config_bytes(ctx)
    CONFIG.map { |name| File.binread(Harness.located(ctx, name)) }
  end

  def vault_names(ctx, file = 'likeness.skmv')
    vault = VoxgigSekreto.openvault('file' => Harness.located(ctx, file), 'key' => 'master', 'passphrase' => MASTER)
    vault.list
  ensure
    vault&.close
  end

  def test_a_second_rename_that_fails_puts_the_first_file_back_and_leaves_no_temporary_file
    in_folder('likeness.json' => "old likeness\n", 'station.json' => "old station\n") do |dir|
      likeness = File.join(dir, 'likeness.json')
      station = File.join(dir, 'station.json')
      err = assert_raises(Likeness::WriteError) do
        Likeness.write_all([Likeness::Write.new(path: likeness, text: "new likeness\n", was: was(likeness)),
                            Likeness::Write.new(path: station, text: "new station\n", was: was(station))],
                           Failing.new(2))
      end
      assert err.restored
      assert_equal station, err.path
      assert_equal "old likeness\n", File.read(likeness)
      assert_equal "old station\n", File.read(station)
      assert_equal %w[likeness.json station.json], Dir.children(dir).sort
    end
  end

  def test_a_file_that_cannot_be_put_back_is_reported_as_not_restored
    in_folder('likeness.json' => "old likeness\n", 'station.json' => "old station\n") do |dir|
      likeness = File.join(dir, 'likeness.json')
      station = File.join(dir, 'station.json')
      err = assert_raises(Likeness::WriteError) do
        Likeness.write_all([Likeness::Write.new(path: likeness, text: "new likeness\n", was: was(likeness)),
                            Likeness::Write.new(path: station, text: "new station\n", was: was(station))],
                           Failing.new(2, 3))
      end
      refute err.restored
      assert_equal ["new likeness\n", "old station\n"], [File.read(likeness), File.read(station)]
      assert_equal %w[likeness.json station.json], Dir.children(dir).sort
    end
  end

  def test_a_file_that_was_not_there_is_gone_again_when_the_rename_after_it_fails
    in_folder('station.json' => "old station\n") do |dir|
      station = File.join(dir, 'station.json')
      assert_raises(Likeness::WriteError) do
        Likeness.write_all([Likeness::Write.new(path: File.join(dir, 'likeness.json'), text: "new likeness\n"),
                            Likeness::Write.new(path: station, text: "new station\n", was: was(station))],
                           Failing.new(2))
      end
      assert_equal ['station.json'], Dir.children(dir)
      assert_equal "old station\n", File.read(station)
    end
  end

  def test_a_first_rename_that_fails_changes_nothing_and_a_write_that_succeeds_keeps_each_files_mode
    in_folder('likeness.json' => "old likeness\n", 'station.json' => "old station\n") do |dir|
      likeness = File.join(dir, 'likeness.json')
      station = File.join(dir, 'station.json')
      writes = lambda do
        [Likeness::Write.new(path: likeness, text: "new likeness\n", was: was(likeness)),
         Likeness::Write.new(path: station, text: "new station\n", was: was(station).tap { |w| w.mode = 0o640 })]
      end
      assert_raises(Likeness::WriteError) { Likeness.write_all(writes.call, Failing.new(1)) }
      assert_equal ["old likeness\n", "old station\n"], [File.read(likeness), File.read(station)]
      assert_equal %w[likeness.json station.json], Dir.children(dir).sort
      Likeness.write_all(writes.call)
      assert_equal ["new likeness\n", "new station\n"], [File.read(likeness), File.read(station)]
      assert_equal 0o640, File.stat(station).mode & 0o777
      assert_equal %w[likeness.json station.json], Dir.children(dir).sort
    end
  end

  def test_sources_add_whose_second_rename_fails_changes_neither_file_and_takes_its_token_out_of_the_vault
    ctx = Harness.build_ctx(entry('connections/add-keeps-the-file'))
    before = config_bytes(ctx)
    ctx.fs = Failing.new(2)
    r = Likeness.run(ctx)
    assert_equal 3, r.exit, r.stdout
    env = JSON.parse(r.stdout)
    assert_equal 'invalid-project', env['code']
    assert_equal '~/.config/likeness/station.json could not be written, and nothing was changed', env['error']['message']
    assert_equal before, config_bytes(ctx)
    assert_equal %w[likeness.json likeness.skmv station.json], Dir.children(ctx.dir).sort
    assert_equal %w[joplin.apikey notion.apikey], vault_names(ctx)
  end

  def test_into_a_home_with_no_configuration_a_failed_second_rename_leaves_neither_file_behind
    ctx = Harness.build_ctx(entry('connections/add-joplin'))
    ctx.fs = Failing.new(2)
    assert_equal 3, Likeness.run(ctx).exit
    assert_equal ['likeness.skmv'], Dir.children(ctx.dir)
    assert_equal %w[joplin.apikey notion.apikey], vault_names(ctx)
  end

  def test_a_configuration_file_that_is_a_symlink_is_written_where_it_points_and_stays_a_symlink
    ctx = Harness.build_ctx(entry('connections/add-keeps-the-file'))
    Dir.mktmpdir('likeness-dotfiles-') do |dotfiles|
      CONFIG.each do |name|
        File.rename(Harness.located(ctx, name), File.join(dotfiles, name))
        File.symlink(File.join(dotfiles, name), Harness.located(ctx, name))
      end
      assert_equal 0, Likeness.run(ctx).exit
      CONFIG.each do |name|
        assert File.lstat(Harness.located(ctx, name)).symlink?, "#{name} is still a link"
        assert_equal File.binread(File.join(Harness::ROOT, 'spec', 'written', 'connections', 'add-keeps-the-file', name)),
                     File.binread(File.join(dotfiles, name)), name
      end
      assert_equal %w[likeness.json station.json], Dir.children(dotfiles).sort
    end
  end

  def test_a_remove_or_a_rename_whose_second_rename_fails_changes_neither_file
    %w[connections/remove connections/rename].each do |id|
      ctx = Harness.build_ctx(entry(id))
      before = config_bytes(ctx)
      ctx.fs = Failing.new(2)
      assert_equal 3, Likeness.run(ctx).exit, id
      assert_equal before, config_bytes(ctx), id
      assert_equal %w[likeness.json station.json], Dir.children(ctx.dir).sort, id
    end
  end

  # The next command, run over what the files now say, with the SDK's offline transport seeded.
  def following(ctx, argv, seeded)
    station, accounts = Likeness.load_config(Harness.located(ctx, 'station.json'), 'default')
    r = Likeness.run(Likeness::Ctx.new(argv: argv, clock: '2026-10-15T00:00:00Z', station: station, accounts: accounts,
                                       fixture: { seeded => Harness.seed_of('joplin') }, home: ctx.home, dir: ctx.dir))
    [r.exit, JSON.parse(r.stdout)]
  end

  def test_a_connection_sources_add_writes_is_one_the_next_commands_read_and_reach
    ctx = Harness.build_ctx(entry('connections/add-joplin'))
    assert_equal 0, Likeness.run(ctx).exit
    exit, listed = following(ctx, %w[list --json], 'joplin$work')
    assert_equal 0, exit
    refute_empty listed['data']
    listed['data'].each do |n|
      assert_equal 'joplin$work', n['instance']
      assert_equal Likeness.lid('joplin', 'local', 'note', n['id']), n['lid']
    end
    exit, doctor = following(ctx, %w[doctor --json], 'joplin$work')
    assert_equal [0, 'ok', 1], [exit, doctor['code'], doctor['data'].length]
  end

  def test_a_rename_changes_no_notes_lid_since_the_account_moves_with_the_ref
    ctx = Harness.build_ctx(entry('connections/rename'))
    exit, before = following(ctx, ['get', "joplin$work:#{NOTE}", '--json'], 'joplin$work')
    assert_equal 0, exit
    assert_equal 0, Likeness.run(ctx).exit
    exit, after = following(ctx, ['get', "joplin$office:#{NOTE}", '--json'], 'joplin$office')
    assert_equal 0, exit
    assert_equal before['data'][0]['lid'], after['data'][0]['lid']
    assert_equal Likeness.lid('joplin', 'office', 'note', NOTE), before['data'][0]['lid']
  end

  def test_a_remove_leaves_no_account_behind_and_a_configuration_the_next_command_reads
    ctx = Harness.build_ctx(entry('connections/remove'))
    assert_equal 0, Likeness.run(ctx).exit
    accounts = Likeness.parse_accounts(File.read(Harness.located(ctx, 'likeness.json')), 'likeness.json', 'default')
    refute accounts.key?('joplin$work')
    _, listed = following(ctx, %w[sources list --json], 'joplin')
    assert_equal ['joplin', 'joplin$a-b', 'notion$docs'], listed['data'].map { |row| row['instance'] }
  end

  # A TLS server counting the application bytes each connection sends it.
  def plugin(cert)
    tcp = TCPServer.new('127.0.0.1', 0)
    context = OpenSSL::SSL::SSLContext.new
    context.cert = cert.x509
    context.key = cert.pkey
    bytes = []
    threads = []
    acceptor = Thread.new do
      loop do
        raw = tcp.accept
        at = bytes.length
        bytes << 0
        threads << Thread.new do
          ssl = OpenSSL::SSL::SSLSocket.new(raw, context)
          ssl.accept
          loop { bytes[at] += ssl.readpartial(65_536).bytesize }
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
    ["https://127.0.0.1:#{tcp.addr[1]}", bytes, stop]
  end

  def probed(id, args)
    e = entry(id)
    e['args'] = args
    ctx = Harness.build_ctx(e)
    ctx.presented = ->(base) { Likeness.presented_fingerprint(base) }
    [ctx, Likeness.run(ctx)]
  end

  def test_sources_add_pins_the_certificate_the_plugin_presents_read_by_a_probe_that_writes_nothing_to_it
    cert = Cert.self_signed
    base, bytes, stop = plugin(cert)
    begin
      ctx, r = probed('connections/add-obsidian-confirmed',
                      ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', base, '--json'])
      assert_equal 0, r.exit, r.stdout
      pinned = JSON.parse(File.read(Harness.located(ctx, 'station.json')))['profiles']['default']['sdk']['obsidian']
      fingerprint = Likeness.fingerprint_of(cert.der)
      assert_equal({ 'base' => base, 'options' => { 'tls' => { 'fingerprint' => fingerprint } } }, pinned)
      assert_equal "obsidian at #{base} presents #{fingerprint}; type yes to pin it", Harness::PROMPTS[ctx][0]
      assert_equal [0], bytes
    ensure
      stop.call
    end
  end

  def test_a_fingerprint_the_plugin_does_not_present_is_refused_and_nothing_is_written
    base, bytes, stop = plugin(Cert.self_signed)
    begin
      ctx, r = probed('connections/add-obsidian-fingerprint-differs',
                      ['sources', 'add', '--source', 'obsidian', '--account', 'wirevault', '--base', base,
                       '--fingerprint', Likeness.fingerprint_of(Cert.self_signed.der), '--json'])
      assert_equal [4, 'certificate-rejected'], [r.exit, JSON.parse(r.stdout)['code']]
      refute File.exist?(Harness.located(ctx, 'station.json'))
      assert_equal [0], bytes
    ensure
      stop.call
    end
  end

  def test_where_the_capability_data_says_a_source_names_its_account_it_is_asked_and_account_refused
    row = Likeness::CAPS['joplin']['connect']['account']
    row['discover'] = true
    Likeness::Joplin.define_singleton_method(:account) do |client|
      client.Note.list({})
      'discovered-profile'
    end
    begin
      e = entry('connections/add-joplin')
      e['args'] = %w[sources add --source joplin --instance work --json]
      ctx = Harness.build_ctx(e)
      ctx.fixture = { 'joplin$work' => Harness.seed_of('joplin') }
      r = Likeness.run(ctx)
      assert_equal 0, r.exit, r.stdout
      assert_equal [{ 'instance' => 'joplin$work', 'method' => 'GET', 'path' => '/notes' }], r.calls
      accounts = Likeness.parse_accounts(File.read(Harness.located(ctx, 'likeness.json')), 'likeness.json', 'default')
      assert_equal({ 'joplin$work' => 'discovered-profile' }, accounts)

      refused = Likeness.run(Harness.build_ctx(entry('connections/add-joplin')))
      assert_equal [3, 'invalid-argument'], [refused.exit, JSON.parse(refused.stdout)['code']]
    ensure
      row['discover'] = false
      Likeness::Joplin.singleton_class.remove_method(:account)
    end
  end

  def likeness(env, home, *args)
    Open3.capture3(env, RbConfig.ruby, BIN, *args, chdir: home, unsetenv_others: true)
  end

  def test_the_argv_shell_writes_station_json_where_config_names_it_and_likeness_json_beside_it
    Dir.mktmpdir('likeness-') do |home|
      dir = File.join(home, 'elsewhere')
      FileUtils.mkdir_p(dir)
      FileUtils.cp(File.join(Harness::ROOT, 'fixtures', 'vault', 'likeness.skmv'), dir)
      config = File.join(dir, 'my-station.json')
      env = { 'HOME' => home, 'PATH' => ENV.fetch('PATH', ''), 'LIKENESS_PASSPHRASE' => MASTER }
      out, err, status = likeness(env, home, 'sources', 'add', '--source', 'joplin', '--account', 'local',
                                  '--secret', 'joplin.apikey', '--json', '--config', config)
      assert_equal 0, status.exitstatus, out + err
      assert_equal({ 'joplin' => { 'base' => 'http://127.0.0.1:41184' } },
                   JSON.parse(File.read(config))['profiles']['default']['sdk'])
      assert_equal({ 'joplin' => { 'account' => 'local' } },
                   JSON.parse(File.read(File.join(dir, 'likeness.json')))['profiles']['default']['instances'])
      out, err, status = likeness(env, home, 'sources', 'list', '--json', '--config', config)
      assert_equal 0, status.exitstatus, err
      assert_equal([{ 'account' => 'local', 'base' => 'http://127.0.0.1:41184', 'instance' => 'joplin',
                      'secret' => 'joplin.apikey', 'source' => 'joplin' }], JSON.parse(out)['data'])
    end
  end
end
