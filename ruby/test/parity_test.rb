# frozen_string_literal: true

require 'fileutils'

require_relative 'harness'

# The RAW transcript output, for tools/parity.mjs to compare across ports.
class ParityEmitTest < Minitest::Test
  def test_emit_parity_outputs
    out = ENV.fetch('LIKENESS_PARITY_OUT', '')
    skip 'LIKENESS_PARITY_OUT is not set' if out.empty?

    Harness.entries('cli').each do |e|
      r = Likeness.run(Harness.build_ctx(e))
      dst = File.join(out, Likeness::PORT, "#{e['id']}.out")
      FileUtils.mkdir_p(File.dirname(dst))
      # exit, stdout and stderr in one file: a difference in any is one comparison.
      File.binwrite(dst, "exit #{r.exit}\n--stdout--\n#{r.stdout}--stderr--\n#{r.stderr}")
    end
  end
end
