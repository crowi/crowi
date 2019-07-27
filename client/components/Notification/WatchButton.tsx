import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Button } from 'reactstrap'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'

interface Props extends WithTranslation {
  pageId: string | null
  crowi: Crowi
}

interface State {
  watching: boolean
  isChanging: boolean
  creationError: boolean
}

class WatchButton extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      watching: false,
      isChanging: false,
      creationError: false,
    }

    this.watch = this.watch.bind(this)
  }

  async componentDidMount() {
    try {
      const { watching = false } = await this.props.crowi.apiGet('/pages.watch.status', { page_id: this.props.pageId })
      this.setState({ watching })
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error(err.message)
      }
    }
  }

  async watch() {
    const { crowi, pageId } = this.props
    const { watching } = this.state
    this.setState({ isChanging: true, creationError: false })
    try {
      const {
        ok,
        watcher: { status },
      } = await crowi.apiPost('/pages.watch', { page_id: pageId, status: !watching })
      if (ok) {
        this.setState({ watching: status === 'WATCH' })
      }
    } catch (err) {
      this.setState({ creationError: true })
    } finally {
      this.setState({ isChanging: false })
    }
  }

  render() {
    const { t } = this.props
    const { watching } = this.state
    const text = watching ? 'Watched' : 'Watch'

    return (
      <Button size="sm" outline onClick={this.watch} active={watching}>
        <Icon name="eye" /> {t(text)}
      </Button>
    )
  }
}

export default withTranslation()(WatchButton)
