# frozen_string_literal: true

require_relative 'envelope'

module Likeness
  # A note is a Hash with string keys. An absent key means NOT FETCHED, which
  # sorts apart from a null.
  ABSENT = Object.new.freeze

  module_function

  def sort_notes(notes, key = nil)
    keyed = !key.nil? && !key.empty?
    # Ruby's sort is not stable, and notes from different connections can share a lid.
    notes.each_with_index.sort do |(a, i), (b, j)|
      c = keyed ? compare_field(a.fetch(key, ABSENT), b.fetch(key, ABSENT)) : 0
      c = -compare_code_points(a['updated'], b['updated']) if c.zero?
      c = compare_code_points(a['lid'], b['lid']) if c.zero?
      c.zero? ? i <=> j : c
    end.map(&:first)
  end

  def rank(value)
    case value
    when ABSENT then 4
    when nil then 3
    when true, false then 0
    when Numeric then 1
    when String then 2
    else 5
    end
  end

  def compare_field(a, b)
    ra = rank(a)
    rb = rank(b)
    return ra <=> rb unless ra == rb
    return compare_code_points(a, b) if a.is_a?(String)
    return a <=> b if a.is_a?(Numeric)
    return (a ? 1 : 0) <=> (b ? 1 : 0) if 0 == ra

    0
  end
end
