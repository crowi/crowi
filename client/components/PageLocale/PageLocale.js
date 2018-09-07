import React from 'react'
import PropTypes from 'prop-types'
import { InputGroup, Input } from 'reactstrap'

class PageLocale extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      language: '',
    }

    this.updateLanguageField = this.updateLanguageField.bind(this)
  }

  async updateLanguageField() {
    const markdown = document.getElementById('form-body').value
    const japansese = markdown.match(/[\u30a0-\u30ff\u3040-\u309f\u3005-\u3006\u30e0-\u9fcf]+/g)
    const japaneseLength = japansese.map(({ length }) => length).reduce((p, c) => p + c)
    const contentsLength = markdown.length
    const language = japaneseLength / contentsLength > 0.1 ? 'ja' : 'en'
    if (language !== this.state.language) {
      this.setState({ language })
    }
  }

  componentDidMount() {
    document.getElementById('form-body').addEventListener('change', this.updateLanguageField)
    this.updateLanguageField()
  }

  render() {
    const { language } = this.state
    return (
      <InputGroup className="mr-2">
        <Input defaultValue={language} />
      </InputGroup>
    )
  }
}

PageLocale.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string,
}

PageLocale.defaultProps = {}

export default PageLocale
