# frozen_string_literal: true

# At load, before any station opens: station validates with whatever
# VoxgigStruct is defined, and this SDK always loads its own copy.
require 'Joplin_sdk'

require_relative '../caps'
require_relative '../envelope'
require_relative '../errors'
require_relative '../identity'

module Likeness
  module Joplin
    SOURCE = 'joplin'
    SUPPLIES = %w[source instance space title body created updated].freeze

    # Joplin answers id, parent_id and title unless asked, and reads `fields`, not the declared `field`.
    FIELDS = 'id,parent_id,title,body,created_time,updated_time'

    module_function

    # The ref rides the station feature: a top-level `instance` or `as` reaches the SDK, which refuses it.
    def connect(station, instance, seed = nil)
      feature = { 'station' => { 'instance' => instance } }
      feature['test'] = seed.merge('active' => true) unless seed.nil?
      station.connect(JoplinSDK, 'feature' => feature)
    end

    def ms(value)
      return value if value.is_a?(Integer)
      return value.to_i if value.is_a?(Float) && value.finite? && value == value.truncate

      0
    end

    def stamp(value, field)
      Likeness.rfc3339(ms(value))
    rescue RangeError
      raise LikenessError.new('source-unavailable',
                              "the source returned a #{SOURCE} record whose #{field} is outside the years 0000 to 9999",
                              'this is a bug in the source or its SDK; run with --raw to capture the payload')
    end

    def project(raw, instance, account, with_raw)
      raw = {} unless raw.is_a?(Hash)
      id = raw['id'].nil? ? '' : Likeness.text_of(raw['id'])
      if id.empty?
        raise LikenessError.new('source-unavailable', "the source returned a #{SOURCE} record with no id",
                                'this is a bug in the source or its SDK; run with --raw to capture the payload')
      end
      note = {
        'lid' => Likeness.lid(SOURCE, account, 'note', id),
        'source' => SOURCE,
        'instance' => instance,
        'id' => id,
        'title' => raw['title'].nil? ? '' : Likeness.text_of(raw['title']),
        'url' => "joplin://x-callback-url/openNote?id=#{id}",
        'created' => stamp(raw['created_time'], 'created_time'),
        'updated' => stamp(raw['updated_time'], 'updated_time'),
      }
      space = raw['parent_id'].nil? ? '' : Likeness.text_of(raw['parent_id'])
      note['space'] = space unless space.empty?
      note['body'] = Likeness.text_of(raw['body']) unless raw['body'].nil?
      # A string, re-rendered: the envelope forbids the payload's floats, and the client keeps no bytes.
      note['raw'] = Likeness.render_raw(raw) if with_raw
      note
    end

    def data(entity)
      entity.respond_to?(:data_get) ? entity.data_get : entity
    end

    def list_notes(client, conn, with_raw)
      rows = (client.Note.list({ 'fields' => FIELDS }) || []).map { |e| data(e) }
      limit = Likeness.page_max(SOURCE)
      {
        notes: rows.map { |r| project(r, conn.instance, conn.account, with_raw) },
        more: limit.positive? && limit <= rows.length,
      }
    end

    def load_note(client, conn, id, with_raw)
      row = data(client.Note.load({ 'id' => id, 'fields' => FIELDS }))
      return nil unless row.is_a?(Hash) && row.key?('id')

      project(row, conn.instance, conn.account, with_raw)
    rescue StandardError => e
      return nil if 404 == Likeness.status_of(e)

      raise
    end

    def check(client)
      client.Note.list({ 'fields' => FIELDS })
      { ok: true, detail: 'ok' }
    rescue StandardError => e
      case Likeness.status_of(e)
      when 401, 403 then { ok: false, code: 'auth-failed', detail: 'the token was rejected' }
      when 429 then { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
      else { ok: false, code: 'source-unavailable', detail: 'the application did not answer' }
      end
    end
  end

  module_function

  # The SDK's status, never its message text, which differs between ports.
  def status_of(err)
    err.respond_to?(:status) ? err.status : nil
  end
end
