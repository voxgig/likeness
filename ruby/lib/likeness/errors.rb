# frozen_string_literal: true

require_relative 'spec'

module Likeness
  ERRORS = Spec.load('errors')['error'].freeze

  # A refusal carrying the code that names it and the remedy that fixes it.
  class LikenessError < StandardError
    attr_reader :code, :remedy, :detail

    def initialize(code, message, remedy, detail = {})
      super(message)
      @code = code
      @remedy = remedy
      @detail = detail
    end
  end

  module_function

  def exit_for(code)
    spec = ERRORS[code]
    raise ArgumentError, "no such error code: #{code}" if spec.nil?

    spec['exit']
  end

  # The closed set of codes permitted to carry data on failure.
  def partial_codes
    ERRORS.values.select { |e| e['partial'] }.map { |e| e['code'] }.sort
  end

  # The SDK's status, never its message text, which differs between ports.
  def status_of(err)
    err.respond_to?(:status) ? err.status : nil
  end
end
