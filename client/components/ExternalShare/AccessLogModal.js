import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import moment from 'moment'
import platform from 'platform'
import { Modal, ModalHeader, ModalBody, Table, Alert } from 'reactstrap'
import Pagination from 'components/Common/Pagination'

class AccessLogModal extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      requesting: false,
      pageId: null,
      shares: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
      error: false,
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderAccessLogTable = this.renderAccessLogTable.bind(this)
  }

  renderShareInfo(uuid, username, name, createdAt, isActive) {
    const { t } = this.props
    const date = moment(createdAt).format('llll')
    return (
      <div>
        <h4>
          {(isActive && (
            <span>
              {t('Share ID')}: <a href={`/_share/${uuid}`}>{uuid}</a> <span className="label label-success">Active</span>
            </span>
          )) || (
            <span>
              {t('Share ID')}: {uuid} <span className="label label-danger">Inactive</span>
            </span>
          )}
        </h4>
        <dl className="share-info">
          <div>
            <dt>{t('Creator')}</dt>
            <dd>
              <a href={`/user/${username}`}>{name}</a>
            </dd>
          </div>
          <div>
            <dt>{t('Created')}</dt>
            <dd>{date}</dd>
          </div>
        </dl>
      </div>
    )
  }

  renderTableHeader() {
    const { t } = this.props
    return (
      <thead>
        <tr>
          <th>#</th>
          <th>{t('Browser')}</th>
          <th>OS</th>
          <th>{t('IP Address')}</th>
          <th>{t('Last Accessed')}</th>
        </tr>
      </thead>
    )
  }

  static renderTableBody(accesses, i) {
    const {
      tracking: { userAgent, remoteAddress },
      lastAccessedAt,
    } = accesses
    const index = i + 1
    const info = platform.parse(userAgent)
    const date = moment(lastAccessedAt).format('llll')
    return (
      <tr key={i}>
        <td>{index}</td>
        <td>{info.name}</td>
        <td>{info.os.toString()}</td>
        <td>{remoteAddress}</td>
        <td>{date}</td>
      </tr>
    )
  }

  renderAccessLogTable(share, i) {
    const { t } = this.props
    const {
      uuid,
      creator: { name, username },
      createdAt,
      accesses,
      status,
    } = share
    return (
      <div key={i}>
        {this.renderShareInfo(uuid, username, name, createdAt, status === 'active')}
        {accesses.length > 0 ? (
          <Table bordered hover condensed>
            {this.renderTableHeader()}
            <tbody>{accesses.map(AccessLogModal.renderTableBody)}</tbody>
          </Table>
        ) : (
          <Alert color="info">{t('No one accessed yet')}</Alert>
        )}
      </div>
    )
  }

  async getPage(pageId, options = {}) {
    const limit = this.state.pagination.limit
    if (!this.state.error && !this.state.requesting) {
      this.setState({ requesting: true })

      try {
        const { share } = await this.props.crowi.apiGet('/shares.list', {
          limit: 5,
          page_id: pageId,
          populate_accesses: true,
          ...options,
        })
        const { docs: shares, total, page: current, pages: count } = share
        const pagination = { total, current, count, limit }
        this.setState({ pageId, shares, pagination, requesting: false })
      } catch (err) {
        this.setState({ error: true, requesting: false })
      }
    }
  }

  movePage(i) {
    if (i !== this.state.pagination.current) {
      this.getPage(this.state.pageId, { page: i })
    }
  }

  componentDidMount() {
    const { pageId = null } = this.props
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  componentDidUpdate() {
    const { pageId = null } = this.props
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  renderPagination() {
    const { current, count } = this.state.pagination
    const range = [...Array(count).keys()]
    const items = range.map((v, k) => {
      const page = k + 1
      const className = page === current ? 'active' : ''
      return (
        <li key={page} className={className}>
          <a onClick={this.movePage(page)}>{page}</a>
        </li>
      )
    })
    return (
      <nav>
        <ul className="pagination">
          <li className={current === 1 ? 'disabled' : ''}>
            <a onClick={this.movePage(1)}>&laquo;</a>
          </li>
          {items}
          <li className={current === count ? 'disabled' : ''}>
            <a onClick={this.movePage(count)}>&raquo;</a>
          </li>
        </ul>
      </nav>
    )
  }

  render() {
    const { t, show, onHide } = this.props
    const {
      pagination: { total, current, count },
      error,
    } = this.state
    return (
      <Modal className="access-log-modal" isOpen={show} toggle={onHide} size="lg">
        <ModalHeader>{t('Access Log')}</ModalHeader>
        <ModalBody>
          {error ? (
            <Alert color="danger">
              <p>{t('modal_access_log.error.message')}</p>
            </Alert>
          ) : total === 0 ? (
            <Alert color="info">
              <p>{t('modal_access_log.no_access_log_is_exists_yet')}</p>
            </Alert>
          ) : (
            <div>
              {this.state.shares.map(this.renderAccessLogTable)}
              <Pagination current={current} count={count} onClick={this.movePage} />
            </div>
          )}
        </ModalBody>
      </Modal>
    )
  }
}

AccessLogModal.propTypes = {
  show: PropTypes.bool.isRequired,
  onHide: PropTypes.func.isRequired,
  pageId: PropTypes.string,
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AccessLogModal)
