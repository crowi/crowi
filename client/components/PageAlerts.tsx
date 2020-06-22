import React from 'react'
import PageAlert from './PageAlerts/PageAlert'
import Crowi from 'client/util/Crowi'
import { User, Page } from 'client/types/crowi'

interface Props {
  pageId: string | null
  crowi: Crowi
}

interface State {
  alertAppeared: boolean
  message: string
  data: {
    user?: User
  }
}

export default class PageAlerts extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      alertAppeared: false,
      message: '',
      data: {},
    }
  }

  componentDidMount() {
    const socket = this.props.crowi.getWebSocket()

    socket.on('page edited', (data: { user: User; page: Page }) => {
      const target = data.user
      const { pageId, crowi } = this.props
      const user = crowi.getUser()

      if (target.username != user.username && pageId == data.page._id) {
        this.setState({
          alertAppeared: true,
          message: 'edit',
          data: data,
        })
      }
    })
  }

  render() {
    //    const attachmentToDelete = this.state.attachmentToDelete;

    if (!this.state.alertAppeared) {
      return null
    }

    return <PageAlert {...this.state} />
  }
}
