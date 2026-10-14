# frozen_string_literal: true

require 'Joplin_sdk'

require_relative '../caps'
require_relative '../envelope'
require_relative '../errors'
require_relative '../identity'

module Likeness
  module Joplin
    SOURCE = 'joplin'
    SUPPLIES = %w[source instance space title body created updated].freeze

    # Joplin answers id, parent_id and title unless asked. The wire name is
    # `fields`; the client declares `field`, which Joplin ignores.
    FIELDS = 'id,parent_id,title,body,created_time,updated_time'

    module_function

    # The ref goes in the station feature's options, never beside them: the
    # SDK would receive a top-level `instance` or `as`.
    def connect(station, instance, seed = nil)
      feature = { 'station' => { 'instance' => instance } }
      feature['test'] = seed.merge('active' => true) unless seed.nil?
      station.connect(JoplinSDK, 'feature' => feature)
    end

    # A timestamp that is not an integral number is the epoch.
    def ms(value)
      return value if value.is_a?(Integer)
      return value.to_i if value.is_a?(Float) && value.finite? && value == value.truncate

      0
    end

    def project(raw, instance, account, with_raw)
      raw = {} unless raw.is_a?(Hash)
      id = raw['id'].nil? ? '' : Likeness.text_of(raw['id'])
      # Refused, not fabricated: an empty id gives every such row one lid.
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
        'created' => Likeness.rfc3339(ms(raw['created_time'])),
        'updated' => Likeness.rfc3339(ms(raw['updated_time'])),
      }
      space = raw['parent_id'].nil? ? '' : Likeness.text_of(raw['parent_id'])
      note['space'] = space unless space.empty?
      note['body'] = Likeness.text_of(raw['body']) unless raw['body'].nil?
      # A STRING: the envelope forbids floating point, and a real payload has
      # it. The client keeps no bytes, so the record is re-rendered.
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
      # Throttling has its own retryable code: "did not answer" sends the user
      # to start an application that is running.
      when 429 then { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
      else { ok: false, code: 'source-unavailable', detail: 'the application did not answer' }
      end
    end
  end

  module_function

  # The HTTP status the SDK put on its error, rather than its message text,
  # which differs between ports and revisions.
  def status_of(err)
    err.respond_to?(:status) ? err.status : nil
  end
end
