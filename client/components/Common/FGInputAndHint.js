import React from 'react'
import PropTypes from 'prop-types'

import { Badge } from 'reactstrap'

export default class C extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      value: null,
      showHint: false,
    }

    this.inputRef = null
    this.hintRefs = []
    this.onFocus = 0

    this.handleInput = this.handleInput.bind(this)
    this.moveFocusOnKeyDown = this.moveFocusOnKeyDown.bind(this)
  }

  handleInput(event) {
    const { value } = event.target
    this.setState({ value, showHint: true })
  }

  moveFocusOnKeyDown(event) {
    const KEY_UP = 38
    const KEY_DOWN = 40

    if (![KEY_UP, KEY_DOWN].includes(event.keyCode)) return

    event.preventDefault()
    event.stopPropagation()

    const length = Object.keys(this.hintRefs).length + 1
    const refs = [this.inputRef, ...this.hintRefs]

    if (event.keyCode === KEY_UP && this.onFocus - 1 >= 0) {
      this.onFocus--
    } else if (event.keyCode === KEY_DOWN && this.onFocus + 1 < length) {
      this.onFocus++
    }
    refs[this.onFocus].focus()
  }

  render() {
    const hint = this.state.showHint ? this.props.hinter(this.state.value) : {}
    this.hintRefs = []
    this.onFocus = 0

    /**
     * TODO: 本当は blur したら hint 表示をしないようにしたいのだけど
     * hint を浮かせるために height: 0 にしてる関係上、判定が狂うのかわからないけど動かない
     */
    return (
      <div className="fg-input-w-hint w-100" onClick={() => this.inputRef.focus()}>
        <div className={`input form-control ${Object.keys(hint).length > 0 ? 'w-hint' : ''}`}>
          {Object.entries(this.props.chosen).map(([key, value]) => {
            return (
              <Badge
                className="badge"
                color="primary"
                key={key}
                onClick={event => {
                  event.preventDefault()
                  event.stopPropagation()

                  this.props.handleRemove(key)

                  this.inputRef.value = ''
                  this.setState({
                    value: '',
                    showHint: false,
                  })
                  this.inputRef.focus()
                }}
              >
                <span>{value}</span>
              </Badge>
            )
          })}
          <input
            ref={ref => {
              this.inputRef = ref
            }}
            onChange={this.handleInput}
            onKeyDown={event => {
              if (event.key !== 'Enter') return this.moveFocusOnKeyDown(event)

              event.preventDefault()
              event.stopPropagation()

              this.hintRefs.length > 0 && this.hintRefs[0].click()
            }}
            disabled={this.props.disabled}
          />
        </div>
        {this.state.showHint && (
          <div className="hint">
            <ul>
              {Object.entries(hint).map(([key, element], index) => {
                return (
                  <li key={key}>
                    <a
                      href="#"
                      onClick={event => {
                        event.preventDefault()
                        event.stopPropagation()

                        this.props.handleAdd(key)

                        this.inputRef.value = ''
                        this.setState({
                          value: '',
                          showHint: false,
                        })
                        this.inputRef.focus()
                      }}
                      ref={ref => {
                        this.hintRefs[index] = ref
                      }}
                      onKeyDown={this.moveFocusOnKeyDown}
                    >
                      {element}
                    </a>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    )
  }
}

C.propTypes = {
  hinter: PropTypes.func.isRequired, // (input: string) => {[id: string]: element}
  chosen: PropTypes.objectOf(PropTypes.string).isRequired, // {[id: string]: string}
  handleAdd: PropTypes.func.isRequired,
  handleRemove: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
}
