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

  # A capability is `false` or absent when refused, and anything else when offered.
  def supports(source, entity, op)
    value = CAPS.dig(source, 'entity', entity, 'op', op)
    !value.nil? && false != value
  end

  # The source's own word for one of likeness's entities, or the entity's name.
  def term_of(source, entity)
    CAPS.dig(source, 'entity', entity, 'term') || entity
  end
end
