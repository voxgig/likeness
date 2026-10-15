# frozen_string_literal: true

require 'fileutils'
require 'rbconfig'
require 'timeout'
require 'tmpdir'

require_relative 'harness'

# The passphrase prompt on a real terminal, answered the moment it appears.
class PromptTest < Minitest::Test
  BIN = File.join(Harness::ROOT, 'ruby', 'bin', 'likeness-rb')
  MASTER = 'fixture master passphrase'
  PROMPT = 'passphrase for master: '

  def setup
    require 'pty'
  rescue LoadError
    skip 'needs a pseudo-terminal'
  end

  def test_a_passphrase_typed_the_moment_the_prompt_appears_is_not_echoed
    Dir.mktmpdir('likeness-prompt-') do |dir|
      FileUtils.cp(File.join(Harness::ROOT, 'fixtures', 'vault', 'likeness.skmv'), dir)
      config = File.join(dir, 'station.json')
      File.write(config, '{ "station": 1, "profiles": { "default": { "sdk": {} } } }')
      env = { 'HOME' => dir, 'PATH' => ENV.fetch('PATH', '') }
      out = +''
      status = nil
      PTY.spawn(env, RbConfig.ruby, BIN, 'secrets', 'list', '--config', config, unsetenv_others: true) do |r, w, pid|
        Timeout.timeout(30) do
          out << r.readpartial(4096) until out.include?(PROMPT)
          w.write("#{MASTER}\r")
          loop { out << r.readpartial(4096) }
        rescue EOFError, Errno::EIO
          nil
        end
        _, status = Process.wait2(pid)
      end
      assert_equal 0, status.exitstatus, out
      assert_equal "#{PROMPT}\r\njoplin.apikey\r\nnotion.apikey\r\n", out
    end
  end
end
