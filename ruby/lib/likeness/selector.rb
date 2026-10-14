# frozen_string_literal: true

module Likeness
  # CLOSED: a selector naming any other field is refused before any request.
  FIELDS = %w[assignee author body created has instance source space state status tag title updated].freeze
  ORDERING_OPS = %w[> < >= <=].freeze
  KEYWORDS = %w[AND and OR or NOT not].freeze

  # A refusal with a place. The offset is in BYTES of the UTF-8 input.
  class SelectorError < StandardError
    attr_reader :offset, :token

    def initialize(message, offset, token)
      super(message)
      @offset = offset
      @token = token
    end

    def code
      'invalid-selector'
    end
  end

  Token = Struct.new(:kind, :text, :offset)

  module_function

  def fields_of(node)
    seen = []
    walk = lambda do |n|
      case n['t']
      when 'or', 'and' then n['kids'].each(&walk)
      when 'not' then walk.call(n['kid'])
      when 'cmp' then seen << n['field']
      else seen.push('title', 'body')
      end
    end
    walk.call(node)
    seen.uniq.sort
  end

  def space?(ch)
    ' ' == ch || "\t" == ch || "\n" == ch || "\r" == ch
  end

  # '-' is not a stop: it negates only at the START of an atom, so `rate-limit`
  # is one word while `-tag:x` is a negation.
  def word_stop?(ch)
    space?(ch) || '()=!><":'.include?(ch)
  end

  def tokenise(input)
    chars = input.chars
    toks = []
    i = 0
    off = 0
    advance = lambda do |n|
      n.times do
        off += chars[i].bytesize
        i += 1
      end
    end

    while i < chars.length
      ch = chars[i]

      if space?(ch)
        advance.call(1)
      elsif '(' == ch || ')' == ch
        toks << Token.new('(' == ch ? 'lparen' : 'rparen', ch, off)
        advance.call(1)
      elsif '"' == ch
        start = off
        advance.call(1)
        value = +''
        closed = false
        while i < chars.length
          c = chars[i]
          if '\\' == c
            advance.call(1)
            break if chars.length <= i

            value << chars[i]
            advance.call(1)
            next
          end
          if '"' == c
            advance.call(1)
            closed = true
            break
          end
          value << c
          advance.call(1)
        end
        raise SelectorError.new('unterminated quoted value', start, "\"#{value}") unless closed

        toks << Token.new('quoted', value, start)
      elsif '!' == ch
        raise SelectorError.new("'!' must be part of '!='", off, '!') unless '=' == chars[i + 1]

        toks << Token.new('op', '!=', off)
        advance.call(2)
      elsif '>' == ch || '<' == ch
        if '=' == chars[i + 1]
          toks << Token.new('op', "#{ch}=", off)
          advance.call(2)
        else
          toks << Token.new('op', ch, off)
          advance.call(1)
        end
      elsif ':' == ch || '=' == ch
        toks << Token.new('op', ch, off)
        advance.call(1)
      elsif '-' == ch && opens_atom?(chars, i, toks.last)
        toks << Token.new('dash', '-', off)
        advance.call(1)
      else
        start = off
        word = +''
        until chars.length <= i || word_stop?(chars[i])
          word << chars[i]
          advance.call(1)
        end
        raise SelectorError.new('unexpected character', start, chars[i]) if word.empty?

        toks << Token.new('word', word, start)
      end
    end

    toks
  end

  def opens_atom?(chars, i, prev)
    0 == i || space?(chars[i - 1]) ||
      %w[lparen op dash].include?(prev.kind) ||
      ('word' == prev.kind && KEYWORDS.include?(prev.text))
  end

  def keyword?(tok, *words)
    !tok.nil? && 'word' == tok.kind && words.include?(tok.text)
  end

  DATE_RE = /\A\d{4}-\d{2}-\d{2}\z/
  DUR_RE = /\A(\d+)(mo|d|w|y)\z/
  MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].freeze

  def leap?(year)
    (0 == year % 4 && 0 != year % 100) || 0 == year % 400
  end

  def days_in(year, month)
    2 == month && leap?(year) ? 29 : MONTH_DAYS[month - 1]
  end

  def classify(tok)
    return { 'k' => 'word', 'v' => tok.text } if 'quoted' == tok.kind

    text = tok.text
    return { 'k' => 'date', 'v' => text } if 'today' == text || 'yesterday' == text

    if DATE_RE.match?(text)
      year, month, day = text.split('-').map { |s| Integer(s, 10) }
      if month < 1 || 12 < month || day < 1 || days_in(year, month) < day
        raise SelectorError.new('date is out of range', tok.offset, text)
      end

      return { 'k' => 'date', 'v' => text }
    end
    m = DUR_RE.match(text)
    unless m.nil?
      # The cap keeps every port's arithmetic exact, in years as in days.
      raise SelectorError.new('duration is out of range', tok.offset, text) if 8 < m[1].length

      return { 'k' => 'dur', 'n' => Integer(m[1], 10), 'unit' => m[2] }
    end
    { 'k' => 'word', 'v' => text }
  end

  # Recursive descent: OR binds loosest, then AND (adjacency implies it), then
  # NOT, then the atom.
  class SelectorParser
    def initialize(toks, finish)
      @toks = toks
      @pos = 0
      @finish = finish
    end

    def peek
      @toks[@pos]
    end

    def take
      tok = @toks[@pos]
      @pos += 1
      tok
    end

    def at_end?
      @toks.length <= @pos
    end

    # With no token the fault is at the END of the input, where a dangling
    # operator went wrong.
    def refuse(message, tok = nil)
      raise SelectorError.new(message, @finish, '') if tok.nil?

      raise SelectorError.new(message, tok.offset, tok.text)
    end

    def parse_or
      kids = [parse_and]
      while Likeness.keyword?(peek, 'OR', 'or')
        take
        refuse('OR must be followed by a term') if at_end?
        kids << parse_and
      end
      1 == kids.length ? kids[0] : { 't' => 'or', 'kids' => kids }
    end

    def parse_and
      kids = [parse_not]
      loop do
        tok = peek
        break if tok.nil? || 'rparen' == tok.kind || Likeness.keyword?(tok, 'OR', 'or')

        if Likeness.keyword?(tok, 'AND', 'and')
          take
          refuse('AND must be followed by a term') if at_end?
        end
        kids << parse_not
      end
      1 == kids.length ? kids[0] : { 't' => 'and', 'kids' => kids }
    end

    def parse_not
      tok = peek
      if Likeness.keyword?(tok, 'NOT', 'not') || (!tok.nil? && 'dash' == tok.kind)
        take
        refuse('NOT must be followed by a term') if at_end?
        return { 't' => 'not', 'kid' => parse_not }
      end
      parse_atom
    end

    def parse_atom
      tok = take
      refuse('unexpected end of selector') if tok.nil?

      case tok.kind
      when 'lparen'
        inner = parse_or
        close = take
        refuse('unclosed group') if close.nil?
        refuse('expected )', close) unless 'rparen' == close.kind
        return inner
      when 'rparen' then refuse('unmatched )', tok)
      when 'op' then refuse('operator with no field', tok)
      when 'dash' then refuse('dangling -', tok)
      when 'quoted' then return { 't' => 'text', 'v' => tok.text }
      end

      op = peek
      return { 't' => 'text', 'v' => tok.text } unless !op.nil? && 'op' == op.kind

      take
      refuse("unknown field \"#{tok.text}\"", tok) unless FIELDS.include?(tok.text)
      ordering = ORDERING_OPS.include?(op.text)
      if ordering && 'created' != tok.text && 'updated' != tok.text
        refuse("\"#{op.text}\" compares dates, which only created and updated hold", op)
      end
      vtok = take
      refuse("\"#{tok.text}#{op.text}\" has no value") if vtok.nil?
      refuse('expected a value', vtok) if %w[op lparen rparen dash].include?(vtok.kind)

      value = Likeness.classify(vtok)
      refuse("\"#{op.text}\" needs a date or a duration, not a bareword", vtok) if ordering && 'word' == value['k']

      { 't' => 'cmp', 'field' => tok.text, 'op' => op.text, 'value' => value }
    end
  end

  def parse_selector(input)
    toks = tokenise(input)
    raise SelectorError.new('empty selector', 0, '') if toks.empty?

    parser = SelectorParser.new(toks, input.bytesize)
    node = parser.parse_or
    unless parser.at_end?
      tok = parser.peek
      raise SelectorError.new('unexpected token', tok.offset, tok.text)
    end
    node
  end
end
