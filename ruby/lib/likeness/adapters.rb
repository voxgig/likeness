# frozen_string_literal: true

require_relative 'adapter/joplin'
require_relative 'adapter/obsidian'

module Likeness
  # Every source's adapter, by the source it names. Each answers SOURCE,
  # SUPPLIES, connect and check, and may answer configure, list_notes and
  # load_note; the handle its connect returns is passed back to it unread.
  ADAPTERS = [Joplin, Obsidian].to_h { |adapter| [adapter::SOURCE, adapter] }.freeze
end
