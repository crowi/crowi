import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import platform from 'platform'
import { Modal, ModalHeader, ModalBody, Table, Alert } from 'reactstrap'
import Pagination from 'components/Common/Pagination'
import Crowi from 'client/util/Crowi'
import { Share, ShareAccess } from 'client/types/crowi'
import format, { formatToLocaleString } from 'client/util/formatDate'

interface Props extends WithTranslation {
  show: boolean
  onHide: () => void
  pageId: string | null
  crowi: Crowi
}

interface State {
  requesting: boolean
  pageId: string | null
  shares: []
  pagination: {
    total: number
    current: number
    count: number
    limit: number
  }
  error: boolean
}

class AccessLogModal extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      requesting: false,
      pageId: null,
      shares: [],
      pagination: {
        total: 0,
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

  renderShareInfo(uuid: string, username: string, name: string, createdAt: string, isActive: boolean) {
    const { t } = this.props
    const date = formatToLocaleString(createdAt)
    return (
      <div>
        <h4>
          {(isActive && (
            <span>
              {t('Share ID')}: <a href={`/_share/${uuid}`}>{uuid}</a> <span className="badge badge-success">Active</span>
            </span>
          )) || (
            <span>
              {t('Share ID')}: {uuid} <span className="badge badge-danger">Inactive</span>
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

  static renderTableBody(accesses: ShareAccess, i: number) {
    const {
      tracking: { userAgent, remoteAddress },
      lastAccessedAt,
    } = accesses
    const index = i + 1
    const { name: platformName, os } = platform?.parse(userAgent) || { name: '', os: { family: '', version: '' } }
    const date = formatToLocaleString(lastAccessedAt)
    return (
      <tr key={i}>
        <td>{index}</td>
        <td>{platformName}</td>
        <td>
          {os?.family} {os?.version}
        </td>
        <td>{remoteAddress}</td>
        <td>{date}</td>
      </tr>
    )
  }

  renderAccessLogTable(share: Share, i: number) {
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

  async getPage(pageId: string | null, options = {}) {
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

  movePage(i: number) {
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

export default withTranslation()(AccessLogModal)
