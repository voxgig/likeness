# frozen_string_literal: true

require 'open3'
require 'rbconfig'
require 'rubygems'
require 'tmpdir'

require_relative 'harness'

class OutsideTest < Minitest::Test
  PORT_DIR = File.join(Harness::ROOT, 'ruby')

  def test_the_port_runs_from_a_directory_with_no_checkout_and_an_empty_home
    Dir.mktmpdir('likeness-') do |home|
      out, err, status = Open3.capture3({ 'HOME' => home, 'PATH' => ENV.fetch('PATH', '') },
                                        RbConfig.ruby, File.join(PORT_DIR, 'bin', 'likeness-rb'), 'version', '--json',
                                        chdir: home, unsetenv_others: true)
      assert_equal 0, status.exitstatus, err
      env = JSON.parse(out)
      assert_equal true, env['ok']
      assert_equal 'rb', env['port']
    end
  end

  def test_no_source_file_reads_the_working_directory
    Dir.glob(File.join(PORT_DIR, '{lib,bin}', '**', '*')).select { |f| File.file?(f) }.each do |f|
      refute_match(/\bDir\.(pwd|getwd)\b/, File.read(f), "#{f} reads the working directory")
    end
  end

  # The specification an installed port reads is data inside the gem.
  def test_the_gem_carries_the_embedded_specification
    spec = Gem::Specification.load(File.join(PORT_DIR, 'likeness.gemspec'))
    refute_nil spec, 'likeness.gemspec did not load'
    %w[caps commands errors help].each do |name|
      assert_includes spec.files, "lib/likeness/spec/#{name}.json"
    end
    assert_includes spec.executables, 'likeness-rb'
  end
end
