import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import moment from 'moment'
import platform from 'platform'
import { Table, Alert } from 'react-bootstrap'
import Pagination from 'components/Common/Pagination'
class AccessLog extends React.Component {
  constructor(props) {
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
      console.log(err)
      this.setState({ error: true })
    }
  }

  movePage(i) {
    if (i !== this.state.pagination.current) {
      this.getPage({ page: i })
    }
  }

  componentDidMount() {
    this.getPage()
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.accesses.map(({ share, tracking, createdAt }, i) => {
          const index = start + i
          const {
            page: { path },
          } = share
          const { userAgent, remoteAddress } = tracking
          const info = platform.parse(userAgent)
          const date = moment(createdAt).format('L')
          return (
            <tr key={index}>
              <td>{index}</td>
              <td>{path}</td>
              <td>{info.name}</td>
              <td>{info.os.toString()}</td>
              <td>{remoteAddress}</td>
              <td>{date}</td>
            </tr>
          )
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
      <Alert bsStyle="danger">
        <p>{t('access_log.error.message')}</p>
      </Alert>
    ) : (
      <div>
        <Table bordered hover condensed>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Page name')}</th>
              <th>{t('Browser')}</th>
              <th>OS</th>
              <th>{t('IP Address')}</th>
              <th>{t('Accessed')}</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        <Pagination current={current} count={count} onClick={this.movePage} />
      </div>
    )
  }
}

AccessLog.propTypes = {
  t: PropTypes.func.isRequired,
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AccessLog)
