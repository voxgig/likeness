# frozen_string_literal: true

require_relative '../sdk'

Likeness.require_sdk('Notion_sdk')

require_relative '../envelope'
require_relative '../errors'
require_relative '../identity'

module Likeness
  module Notion
    SOURCE = 'notion'

    # A page is read without its blocks, so it brings no body and no tags.
    SUPPLIES = %w[source instance space title created updated].freeze

    SDK = NotionSDK

    BUG = 'this is a bug in the source or its SDK; run with --raw to capture the payload'

    # A page id no workspace holds: answered as not found once the token and the version are accepted.
    NO_PAGE = '00000000-0000-0000-0000-000000000000'

    VERSION_RE = /\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z/
    WEB_RE = %r{\Ahttps?://}

    module_function

    # The API version every request carries, pinned in the connection's block in
    # station.json as its one header. Notion refuses a request without it, so a
    # connection that does not pin one is refused before any call.
    def configure(instance, block)
      named = "#{SOURCE} connection \"#{instance}\""
      pin = "pin the API version under sdk.#{instance} in station.json: " \
            '"options": { "headers": { "notion-version": "2022-06-28" } }'
      refuse = ->(what, remedy = pin) { LikenessError.new('invalid-project', "#{named} #{what}", remedy) }

      options = block['options'].nil? ? {} : block['options']
      raise refuse.call('has options that are not a map', 'its options take headers alone') unless options.is_a?(Hash)

      extra = options.keys.reject { |k| 'headers' == k }.min { |a, b| Likeness.compare_code_points(a, b) }
      raise refuse.call("has an option likeness does not read: \"#{extra}\"", 'its options take headers alone') if extra

      headers = options['headers'].nil? ? {} : options['headers']
      raise refuse.call('has headers that are not a map') unless headers.is_a?(Hash)

      names = headers.keys.sort { |a, b| Likeness.compare_code_points(a, b) }
      other = names.find { |k| 'notion-version' != k.downcase }
      raise refuse.call("has a header likeness does not send: \"#{other}\"", 'its headers take notion-version alone') if other
      raise refuse.call('pins no Notion-Version, which every request to Notion carries') if names.empty?
      raise refuse.call('pins Notion-Version more than once') if names.length > 1

      version = headers[names[0]]
      unless version.is_a?(String) && VERSION_RE.match?(version)
        raise refuse.call('pins a Notion-Version that is not a date such as 2022-06-28')
      end

      { 'version' => version }
    end

    # The block `sources add` writes: the pinned version, and the base when one is given.
    def setup(_instance, given, _ask)
      version = given['notion-version']
      unless version.is_a?(String) && VERSION_RE.match?(version)
        raise LikenessError.new('invalid-argument', '--notion-version is not a date such as 2022-06-28',
                                'give the API version as YYYY-MM-DD, as Notion publishes it')
      end

      block = {}
      block['base'] = given['base'] unless given['base'].nil?
      block['options'] = { 'headers' => { 'notion-version' => version } }
      block
    end

    # The ref rides the station feature: a top-level `instance` reaches the SDK, which refuses it.
    def connect(station, conn, config, seed = nil)
      feature = { 'station' => { 'instance' => conn.instance } }
      feature['test'] = seed.merge('active' => true) unless seed.nil?
      station.connect(SDK, 'headers' => { 'notion-version' => config['version'] }, 'feature' => feature)
    end

    # A page's title is its property of type `title`, rich text whose parts' plain
    # text is joined. A page with more than one takes the first by name, in
    # code-point order.
    def title_of(properties)
      return '' unless properties.is_a?(Hash)

      name = properties.keys.sort { |a, b| Likeness.compare_code_points(a, b) }
                       .find { |k| properties[k].is_a?(Hash) && 'title' == properties[k]['type'] }
      return '' if name.nil?

      value = properties[name]['title']
      return value.nil? ? '' : Likeness.text_of(value) unless value.is_a?(Array)

      value.map do |part|
        plain = part.is_a?(Hash) ? part['plain_text'] : part
        plain.nil? ? '' : Likeness.text_of(plain)
      end.join
    end

    # A page's space is its parent database, or its parent page; a workspace or a block is none.
    def space_of(parent)
      return nil unless parent.is_a?(Hash)

      kind = if parent['type'].is_a?(String) then parent['type']
             elsif !parent['database_id'].nil? then 'database_id'
             else 'page_id'
             end
      id = case kind
           when 'data_source_id' then parent['database_id']
           when 'database_id', 'page_id' then parent[kind]
           end
      space = id.nil? ? '' : Likeness.text_of(id)
      space.empty? ? nil : space
    end

    # Text that is not an RFC 3339 date-time, or a value that is not text, is the epoch.
    def stamp(value, field)
      at = value.is_a?(String) ? Likeness.parse_instant(value) || 0 : 0
      Likeness.rfc3339(at)
    rescue RangeError
      raise LikenessError.new('source-unavailable',
                              "#{SOURCE} returned a page whose #{field} is outside the years 0000 to 9999", BUG)
    end

    def project(raw, instance, account, with_raw)
      raise LikenessError.new('source-unavailable', "#{SOURCE} returned a page that is not a record", BUG) unless raw.is_a?(Hash)

      id = raw['id'].nil? ? '' : Likeness.text_of(raw['id'])
      raise LikenessError.new('source-unavailable', "#{SOURCE} returned a page with no id", BUG) if id.empty?
      # Refused, not made up: a page's link is the one thing about it no id can stand in for.
      unless raw['url'].is_a?(String) && WEB_RE.match?(raw['url'])
        raise LikenessError.new('source-unavailable', "#{SOURCE} returned a page with no http or https url", BUG)
      end

      note = {
        'lid' => Likeness.lid(SOURCE, account, 'note', id),
        'source' => SOURCE,
        'instance' => instance,
        'id' => id,
        'title' => title_of(raw['properties']),
        'url' => raw['url'],
        'created' => stamp(raw['created_time'], 'created_time'),
        'updated' => stamp(raw['last_edited_time'], 'last_edited_time'),
      }
      space = space_of(raw['parent'])
      note['space'] = space unless space.nil?
      note['raw'] = Likeness.render_raw(raw) if with_raw
      note
    end

    def data(entity)
      entity.respond_to?(:data_get) ? entity.data_get : entity
    end

    def not_found?(err)
      404 == Likeness.status_of(err)
    end

    def load_note(client, conn, id, with_raw)
      raw = begin
        data(client.Page.load({ 'id' => id }))
      rescue StandardError => e
        return nil if not_found?(e)

        raise
      end
      project(raw, conn.instance, conn.account, with_raw)
    end

    def check(client)
      client.Page.load({ 'id' => NO_PAGE })
      { ok: true, detail: 'ok' }
    rescue StandardError => e
      return { ok: true, detail: 'ok' } if not_found?(e)

      case Likeness.status_of(e)
      when 401, 403 then { ok: false, code: 'auth-failed', detail: 'the token was rejected' }
      when 429 then { ok: false, code: 'rate-limited', detail: 'the source is rate limiting this client' }
      # The one request the check sends that a pinned version can spoil.
      when 400
        { ok: false, code: 'source-unavailable', detail: 'the service refused the request',
          remedy: 'pin a Notion-Version that Notion publishes, such as 2022-06-28, under its connection in station.json' }
      else { ok: false, code: 'source-unavailable', detail: 'the service did not answer' }
      end
    end
  end
end
