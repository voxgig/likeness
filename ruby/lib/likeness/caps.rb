# frozen_string_literal: true

require_relative 'spec'

module Likeness
  CAPS = Spec.load('caps')['capability'].freeze

  module_function

  # The largest page a source returns. Zero is "not declared", which a caller
  # reads as "cannot tell", never as "no limit".
  def page_max(source)
    CAPS.dig(source, 'limit', 'page_max') || 0
  end
end
