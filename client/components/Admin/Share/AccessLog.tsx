import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import platform from 'platform'
import { Table, Alert } from 'reactstrap'
import Pagination from 'components/Common/Pagination'
import Crowi from 'client/util/Crowi'
import { ShareAccess } from 'client/types/crowi'
import { formatToLocaleString } from 'client/util/formatDate'

interface Props extends WithTranslation {
  crowi: Crowi
}

interface State {
  accesses: ShareAccess[]
  pagination: {
    current: number
    count: number
    limit: number
  }
  error: boolean
}

interface Record {
  index: number
  path: string
  info: Platform | undefined
  remoteAddress: string
  date: string
}

class AccessLog extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      accesses: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
      error: false,
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderTableBody = this.renderTableBody.bind(this)
  }

  async getPage(options = {}) {
    const limit = this.state.pagination.limit
    try {
      const { shareAccess } = await this.props.crowi.apiGet('/shares/accesses.list', { ...options, limit })
      const { docs: accesses, page: current, pages: count } = shareAccess
      const pagination = { current, count, limit }
      this.setState({ accesses, pagination })
    } catch (err) {
      this.setState({ error: true })
    }
  }

  movePage(i: number) {
    if (i !== this.state.pagination.current) {
      this.getPage({ page: i })
    }
  }

  componentDidMount() {
    this.getPage()
  }

  renderRecord({ index, path, info, remoteAddress, date }: Record) {
    const { name: platformName = '', os = '' } = info || {}
    return (
      <tr key={index}>
        <td>{index}</td>
        <td>{path ? <a href={path}>{path}</a> : '(Deleted)'}</td>
        <td>{platformName}</td>
        <td>{os.toString()}</td>
        <td>{remoteAddress}</td>
        <td>{date}</td>
      </tr>
    )
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.accesses.map(({ share, tracking: { userAgent, remoteAddress }, lastAccessedAt }, i) => {
          const { page = { path: '' } } = share || {}
          const { path = '' } = page || {}
          return this.renderRecord({
            index: start + i,
            path,
            info: platform.parse ? platform.parse(userAgent) : undefined,
            remoteAddress,
            date: formatToLocaleString(lastAccessedAt),
          })
        })}
      </tbody>
    )
  }

  render() {
    const { t } = this.props
    const {
      pagination: { current, count },
      error,
    } = this.state
    return error ? (
      <Alert color="danger">
        <p>{t('access_log.error.message')}</p>
      </Alert>
    ) : (
      <div>
        <Table bordered hover size="sm">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Page name')}</th>
              <th>{t('Browser')}</th>
              <th>OS</th>
              <th>{t('IP Address')}</th>
              <th>{t('Last Accessed')}</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        <Pagination current={current} count={count} onClick={this.movePage} />
      </div>
    )
  }
}

export default withTranslation()(AccessLog)
