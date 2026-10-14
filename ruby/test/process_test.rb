# frozen_string_literal: true

require 'open3'
require 'rbconfig'
require 'tmpdir'

require_relative 'harness'

# The binary as a process: what the in-process corpus cannot see.
class ProcessTest < Minitest::Test
  BIN = File.join(Harness::ROOT, 'ruby', 'bin', 'likeness-rb')

  def bare_env(home)
    { 'HOME' => home, 'PATH' => ENV.fetch('PATH', '') }
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
