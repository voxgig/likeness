# frozen_string_literal: true

require_relative 'identity'

module Likeness
  DAY_MS = 86_400_000
  UNIT_DAYS = { 'd' => 1, 'w' => 7, 'mo' => 30, 'y' => 365 }.freeze

  module_function

  # ASCII only, A-Z to a-z: the one folding every port applies identically.
  def fold_case(text)
    text.tr('A-Z', 'a-z')
  end

  def midnight_ms(ms)
    day = Time.at(Rational(ms, 1000)).utc
    Time.utc(day.year, day.month, day.day).to_i * 1000
  end

  def resolve_date(value, clock_ms)
    case value['k']
    when 'date'
      return nil if clock_ms.nil? && %w[today yesterday].include?(value['v'])

      case value['v']
      when 'today' then midnight_ms(clock_ms)
      when 'yesterday' then midnight_ms(clock_ms - DAY_MS)
      else parse_rfc3339("#{value['v']}T00:00:00Z")
      end
    when 'dur'
      clock_ms.nil? ? nil : clock_ms - (value['n'] * UNIT_DAYS.fetch(value['unit']) * DAY_MS)
    end
  end

  def field_value(note, field)
    note['tag' == field ? 'tags' : field] if %w[tag space source instance status state title body created updated].include?(field)
  end

  def as_text(value)
    'dur' == value['k'] ? "#{value['n']}#{value['unit']}" : value['v']
  end

  def evaluate(node, note, clock_ms)
    case node['t']
    when 'or' then node['kids'].any? { |k| evaluate(k, note, clock_ms) }
    when 'and' then node['kids'].all? { |k| evaluate(k, note, clock_ms) }
    when 'not' then !evaluate(node['kid'], note, clock_ms)
    when 'text'
      # Full text with no source-side search: a case-insensitive substring over
      # title and body, and the capability matrix says so.
      want = fold_case(node['v'])
      fold_case(note['title']).include?(want) || (!note['body'].nil? && fold_case(note['body']).include?(want))
    else compare(node, field_value(note, node['field']), clock_ms)
    end
  end

  def compare(node, have, clock_ms)
    op = node['op']
    if ORDERING_OPS.include?(op)
      return false unless have.is_a?(String)

      have_ms = parse_rfc3339(have)
      want_ms = resolve_date(node['value'], clock_ms)
      return false if have_ms.nil? || want_ms.nil?

      return have_ms.public_send(op, want_ms)
    end

    want = fold_case(as_text(node['value']))
    if have.is_a?(Array)
      hit = have.any? { |x| fold_case(x.to_s) == want }
      return '!=' == op ? !hit : hit
    end
    eq = !have.nil? && fold_case(have.to_s) == want
    return eq if '=' == op
    return !eq if '!=' == op
    # ':' is contains for free-text fields and equality for the rest.
    return !have.nil? && fold_case(have.to_s).include?(want) if 'title' == node['field'] || 'body' == node['field']

    eq
  end
end
