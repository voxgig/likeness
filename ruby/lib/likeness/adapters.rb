# frozen_string_literal: true

require_relative 'adapter/joplin'
require_relative 'adapter/notion'
require_relative 'adapter/obsidian'

module Likeness
  # Every source's adapter, by the source it names. Each answers SOURCE,
  # SUPPLIES, connect and check, and may answer configure, list_notes,
  # load_note, setup (the block `sources add` writes, the base alone without
  # it) and account; the handle its connect returns is passed back to it unread.
  ADAPTERS = [Joplin, Notion, Obsidian].to_h { |adapter| [adapter::SOURCE, adapter] }.freeze

  # What a setup may ask of the run: a terminal to confirm on, and the
  # fingerprint of the certificate an https base presents.
  Ask = Struct.new(:tty, :confirm, :presented, keyword_init: true)
end
