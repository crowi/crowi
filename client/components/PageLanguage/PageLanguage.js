import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Input, Popover, PopoverHeader, PopoverBody, Button, Table } from 'reactstrap'
import { throttle } from 'throttle-debounce'

class PageLanguage extends React.Component {
  constructor(props) {
    super(props)

    const languages = this.props.crowi.getLanguages()
    const language = document.getElementById('page-language').dataset.language || this.detectLanguage()
    const isEditPage = this.isEditPage()
    this.state = {
      rendered: false,
      language,
      languages,
      detector: {
        auto: true,
        awaiting: null,
      },
      isEditPage,
      popoverOpen: false,
    }

    this.updateLanguageField = this.updateLanguageField.bind(this)
    this.onChange = this.onChange.bind(this)
    this.toggle = this.toggle.bind(this)
    this.approve = this.approve.bind(this)
    this.reject = this.reject.bind(this)

    this.observeMainContent()
  }

  isEditPage(element) {
    element = element || document.getElementById('content-main')
    return element.className.split(' ').includes('on-edit')
  }

  observeMainContent() {
    const observer = new MutationObserver(mutations => {
      const isEditPage = mutations.some(m => this.isEditPage(m.target))
      if (isEditPage) {
        this.onEnter()
      } else {
        this.onExit()
      }
    })
    observer.observe(document.getElementById('content-main'), { attributes: true })
  }

  removeCodeBlock(markdown) {
    return markdown.replace(/```\w*\n[\s\S]*?\n```/g, '')
  }

  detectLanguage() {
    const formBody = document.getElementById('form-body').value
    const markdown = this.removeCodeBlock(formBody)
    const japansese = markdown.match(/[\u30a0-\u30ff\u3040-\u309f\u3005-\u3006\u30e0-\u9fcf]+/g)
    const japaneseLength = japansese === null ? 0 : japansese.map(({ length }) => length).reduce((p, c) => p + c)
    const contentsLength = markdown.length
    const language = japaneseLength / contentsLength > 0.1 ? 'ja' : 'en'
    return language
  }

  updateLanguageField() {
    const language = this.detectLanguage()
    const {
      detector: { auto },
    } = this.state
    if (auto) {
      if (language !== this.state.language) {
        this.setState({ detector: { auto, awaiting: language } })
        this.show()
      } else {
        this.hide()
      }
    }
  }

  onChange(e) {
    this.setState({ language: e.target.value, detector: { auto: false, awaiting: null } })
  }

  onEnter() {
    this.setState({ isEditPage: true })
    this.updateLanguageField()
  }

  onExit() {
    this.setState({ isEditPage: false })
  }

  resolveLanguage(language) {
    this.setState({
      language,
      detector: {
        auto: false,
        awaiting: null,
      },
    })
    this.toggle()
  }

  approve() {
    return this.resolveLanguage(this.state.detector.awaiting)
  }

  reject() {
    return this.resolveLanguage(this.state.language)
  }

  toggle() {
    const { popoverOpen } = this.state
    this.setState({ popoverOpen: !popoverOpen })
  }

  show() {
    const { popoverOpen } = this.state
    if (!popoverOpen) {
      this.setState({ popoverOpen: true })
    }
  }

  hide() {
    const { popoverOpen } = this.state
    if (popoverOpen) {
      this.setState({ popoverOpen: false })
    }
  }

  componentDidMount() {
    document.getElementById('form-body').addEventListener('input', throttle(1000, this.updateLanguageField))
    setTimeout(this.updateLanguageField, 400)
  }

  render() {
    const { t } = this.props
    const {
      language: languageCode,
      languages,
      isEditPage,
      popoverOpen,
      detector: { awaiting: detected },
    } = this.state
    const languageName = code => t(`languages.${code}`)
    const isOpen = isEditPage && popoverOpen
    return (
      <>
        <Input id="pageLanguage" className="mr-2" type="select" name="pageForm[language]" value={languageCode} onChange={this.onChange}>
          {languages.map(code => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </Input>
        {isOpen && (
          <Popover placement="top" isOpen={isOpen} target="pageLanguage" toggle={this.toggle}>
            <PopoverHeader>{t('page_locale.detected_a_new_language')}</PopoverHeader>
            <PopoverBody>
              <Table className="mb-2" borderless>
                <tbody>
                  <tr>
                    <th scope="row">{t('page_locale.current_language')}</th>
                    <td>{languageName(languageCode)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('page_locale.detected_language')}</th>
                    <td>{languageName(detected)}</td>
                  </tr>
                </tbody>
              </Table>
              <div className="d-flex justify-content-end">
                <Button className="mr-2" color="secondary" size="sm" outline onClick={this.reject}>
                  {t('Cancel')}
                </Button>
                <Button color="primary" size="sm" onClick={this.approve}>
                  {t('Change')}
                </Button>
              </div>
            </PopoverBody>
          </Popover>
        )}
      </>
    )
  }
}

PageLanguage.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string,
  t: PropTypes.func.isRequired,
}

PageLanguage.defaultProps = {}

export default translate()(PageLanguage)
