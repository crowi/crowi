import Popper from 'popper.js'

class MentionPopover {
  static duration = 200

  constructor(reference, template) {
    this.count = 0
    this.reference = $(reference)
    this.popover = this.createPopoverFromTemplate(template)
    this.timeIds = { show: null, hide: null, hover: null }
    this.isVisible = false
    this.show = this.show.bind(this)
    this.hide = this.hide.bind(this)
    this.destoroy = this.destoroy.bind(this)
    this.onMouseEnter = this.onMouseEnter.bind(this)
    this.onMouseLeave = this.onMouseLeave.bind(this)

    this.reference.mouseenter(this.onMouseEnter)
    this.reference.mouseleave(this.onMouseLeave)
    this.popover.mouseenter(this.onMouseEnter)
    this.popover.mouseleave(this.onMouseLeave)
    this.user = crowi.findUserById(this.reference.data('id'))
    this.render()
  }

  createPopoverFromTemplate(template) {
    const popover = $(template.cloneNode(true))
    popover.removeAttr('id')
    return popover
  }

  render() {
    const { user, popover } = this
    const { image, name, username } = user
    const a = $(popover).find('a')
    const img = $(popover).find('img')
    const span = $(popover).find('span')
    const body = $('body')
    a.attr('href', `/user/${username}`)
    img.attr('src', image || '/images/userpicture.png')
    span.text(name)
    body.append(popover)
  }

  static create(reference, template) {
    if (!reference || !template) {
      return null
    }
    return new MentionPopover(reference, template)
  }

  clearDelayTimeouts() {
    Object.values(this.timeIds).forEach(id => clearTimeout(id))
  }

  show() {
    const state = this.popover.attr('data-state')
    if (state !== 'visible') {
      this.popper = new Popper(this.reference, this.popover)
      this.clearDelayTimeouts()
      this.popover.show()
      this.popover.attr('data-state', 'visible')
    }
  }

  hide() {
    const state = this.popover.attr('data-state')
    if (state !== 'hidden') {
      this.clearDelayTimeouts()
      this.popover.attr('data-state', 'hidden')
      this.timeIds.hide = setTimeout(() => {
        this.popover.hide()
        this.destoroy()
      }, MentionPopover.duration)
    }
  }

  destoroy() {
    delete this.popper
    this.popover.remove()
  }

  onMouseEnter(e) {
    this.reference = e.target
    this.show()
    this.timeIds.hover = clearTimeout(this.timeIds.hover)
  }

  onMouseLeave(e) {
    this.timeIds.hover = setTimeout(this.hide, 10)
  }
}

export default class MentionPopovers {
  constructor(references, template) {
    this.popovers = {}
    this.references = references
    this.template = document.querySelector(template)
    this.onMouseEnter = this.onMouseEnter.bind(this)

    $('body').on('mouseenter', this.references, this.onMouseEnter)
  }

  static init(references, template) {
    return new MentionPopovers(references, template)
  }

  onMouseEnter(e) {
    const { target } = e
    const popover = MentionPopover.create(target, this.template)
    popover.onMouseEnter(e)
  }
}
