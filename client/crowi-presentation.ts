import Reveal from 'reveal.js'
import hljs from 'highlight.js'

window.Reveal = Reveal

Reveal.initialize({
  controls: true,
  progress: true,
  history: true,
  center: true,
  transition: 'slide',

  // Optional libraries used to extend on reveal.js
  dependencies: [
    {
      src: '/js/reveal/plugin/markdown/marked.js',
      condition: function() {
        return !!document.querySelector('[data-markdown]')
      },
    },
    {
      src: '/js/reveal/plugin/markdown/markdown.js',
      condition: function() {
        return !!document.querySelector('[data-markdown]')
      },
    },
    {
      src: '/js/reveal/plugin/highlight/highlight.js',
      async: true,
      callback: function() {
        hljs.initHighlightingOnLoad()
      },
    },
    {
      src: '/js/reveal/plugin/zoom-js/zoom.js',
      async: true,
    },
    {
      src: '/js/reveal/plugin/notes/notes.js',
      async: true,
    },
  ],
})

Reveal.addEventListener('ready', function(event) {
  // event.currentSlide, event.indexh, event.indexv
  $('.reveal section').each(function(e) {
    const $self = $(this)
    if ($self.children().length == 1) {
      $self.addClass('only')
    }
  })
})
