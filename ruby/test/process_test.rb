# frozen_string_literal: true

require 'open3'
require 'rbconfig'
require 'tmpdir'

require_relative 'harness'

# The binary as a process: what the in-process corpus cannot see.
class ProcessTest < Minitest::Test
  BIN = File.join(Harness::ROOT, 'ruby', 'bin', 'likeness-rb')

  STATION = '{"station":1,"profiles":{"default":{"sdk":{}}}}'

  def bare_env(home)
    { 'HOME' => home, 'PATH' => ENV.fetch('PATH', '') }
  end

  def refusal(path, why)
    "error: invalid-project\n  #{path} #{why}\n  remedy  fix the file, or point --config at another\n"
  end

  def version(home, config)
    Open3.capture3(bare_env(home), RbConfig.ruby, BIN, 'version', '--json', '--config', config,
                   chdir: home, unsetenv_others: true)
  end

  def test_a_configuration_that_cannot_be_read_as_a_file_is_refused_not_taken_for_absent
    Dir.mktmpdir('likeness-') do |home|
      dir = File.join(home, 'cfg')
      FileUtils.mkdir_p(File.join(dir, 'likeness.json'))
      File.write(File.join(dir, 'station.json'), STATION)
      [[dir, dir], [File.join(dir, 'station.json'), File.join(dir, 'likeness.json')]].each do |config, named|
        out, err, status = version(home, config)
        assert_equal 3, status.exitstatus, "#{config}\n#{err}"
        assert_equal '', out
        assert_equal refusal(named, 'cannot be read'), err
      end
    end
  end

  def test_a_configuration_this_process_has_no_permission_to_read_is_refused
    Dir.mktmpdir('likeness-') do |home|
      config = File.join(home, 'station.json')
      File.write(config, STATION)
      File.chmod(0, config)
      readable = begin
        File.binread(config)
        true
      rescue Errno::EACCES
        false
      end
      skip 'this process reads a file without permission to, so the refusal cannot be shown here' if readable

      out, err, status = version(home, config)
      assert_equal 3, status.exitstatus, err
      assert_equal '', out
      assert_equal refusal(config, 'cannot be read'), err
    end
  end

  def test_a_malformed_configuration_is_refused_the_same_way_through_both_flag_forms
    Dir.mktmpdir('likeness-') do |home|
      bad = File.join(home, 'bad.json')
      File.write(bad, '{not json')
      [['list', '--json', "--config=#{bad}"], ['list', '--json', '--config', bad]].each do |args|
        out, err, status = Open3.capture3(bare_env(home), RbConfig.ruby, BIN, *args, chdir: home, unsetenv_others: true)
        assert_equal 3, status.exitstatus, "#{args.join(' ')}\n#{err}"
        assert_equal '', out
        assert_equal "error: invalid-project\n  #{bad} is not valid JSON\n  remedy  fix the file, or point --config at another\n", err
      end
    end
  end

  def test_a_broken_pipe_exits_quietly_with_0
    Dir.mktmpdir('likeness-') do |home|
      reader, writer = IO.pipe
      # The reader is gone before the port starts.
      reader.close
      err_r, err_w = IO.pipe
      pid = Process.spawn(bare_env(home), RbConfig.ruby, BIN, 'version', '--json',
                          chdir: home, unsetenv_others: true, out: writer, err: err_w)
      writer.close
      err_w.close
      _, status = Process.wait2(pid)
      assert_equal '', err_r.read
      assert_equal 0, status.exitstatus
    end
  end
end
