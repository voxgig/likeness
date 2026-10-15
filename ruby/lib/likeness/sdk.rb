# frozen_string_literal: true

module Likeness
  # Every generated Ruby SDK defines its entity classes, typed models and copy
  # of VoxgigStruct at the top level, so each SDK loaded redefines the others'.
  # The warnings are dropped only for a VoxgigStruct identical to the one
  # loaded and for typed models, which nothing likeness runs reads.
  module SDKLoad
    STRUCT = File.join('utility', 'struct', 'voxgig_struct.rb')
    TYPES = /\A[A-Z][A-Za-z0-9]*_types\.rb\z/
    REDEFINED = /\A(.+?):\d+: warning: (?:already initialized constant|method redefined; discarding old) (\S+)\n?\z/
    PREVIOUS = /\A(.+?):\d+: warning: previous definition of (\S+) was here\n?\z/

    @roots = []
    @loading = false
    @later = false
    @held = nil

    class << self
      attr_reader :roots

      def loading?
        @loading
      end

      def entry(feature)
        found = $LOAD_PATH.map { |dir| File.join(dir, "#{feature}.rb") }.find { |f| File.file?(f) }
        raise LoadError, "likeness: no #{feature}.rb on the load path - run `make rb-deps`" if found.nil?

        File.realpath(found)
      end

      # Ruby keeps one VoxgigStruct, and every SDK calls the last one loaded.
      def same_struct!(root)
        mine = File.join(root, STRUCT)
        loaded = defined?(::VoxgigStruct) ? ::VoxgigStruct.method(:getprop).source_location&.first : nil
        return false if loaded.nil?
        return true if File.binread(loaded) == File.binread(mine)

        raise LoadError, "likeness: #{mine} differs from the VoxgigStruct already loaded from #{loaded}, " \
                         'and every SDK would run whichever copy loaded last'
      end

      def require_sdk(feature)
        root = File.dirname(entry(feature))
        @later = same_struct!(root)
        @roots |= [root]
        @loading = true
        begin
          require feature
        ensure
          @loading = false
          held = @held
          @held = nil
          Warning.warn(held) unless held.nil? || dropped?(held, nil)
        end
      end

      # A redefinition is held until the next warning shows whether a note on
      # its previous definition follows; the two are dropped or kept together.
      def screen(message)
        held = @held
        @held = nil
        if held
          return if PREVIOUS.match?(message) && dropped?(held, message)

          yield held unless !PREVIOUS.match?(message) && dropped?(held, nil)
        end
        return @held = message if REDEFINED.match?(message)

        yield message
      end

      # Without a note, a redefinition by a later identical VoxgigStruct
      # replaces an attribute method the copy before it defined.
      def dropped?(head, note)
        h = REDEFINED.match(head)
        return false if h.nil?

        mine = real(h[1])
        return @later && struct?(mine) if note.nil?

        n = PREVIOUS.match(note)
        return false if n.nil? || h[2].split('::').last != n[2]

        theirs = real(n[1])
        return false if mine == theirs

        (struct?(mine) && struct?(theirs)) || (types?(mine) && types?(theirs))
      end

      def struct?(file)
        @roots.any? { |root| File.join(root, STRUCT) == file }
      end

      def types?(file)
        @roots.include?(File.dirname(file)) && TYPES.match?(File.basename(file))
      end

      def real(file)
        File.realpath(file)
      rescue SystemCallError
        File.expand_path(file)
      end
    end

    module Filter
      def warn(message, category: nil, **rest)
        return super unless SDKLoad.loading? && category.nil?

        SDKLoad.screen(message) { |kept| super(kept, category: category, **rest) }
      end
    end
    Warning.singleton_class.prepend(Filter)
  end

  module_function

  def require_sdk(feature)
    SDKLoad.require_sdk(feature)
  end
end
