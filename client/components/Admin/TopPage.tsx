import React, { useContext, useEffect, useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminContext } from 'components/Admin/AdminPage'

interface Info {
  crowiVersion: string | null
  serverInfo: {
    node: {
      arch: string
      version: string
    }
  }
  searchInfo: {
    node?: string
    indexName?: string
    esVersion?: string
  }
}

function useInfo(crowi) {
  const [info, setInfo] = useState<Info>({
    crowiVersion: null,
    serverInfo: {
      node: { arch: '', version: '' },
    },
    searchInfo: {},
  })

  const fetchInfo = async () => {
    const { crowiVersion, serverInfo, searchInfo } = await crowi.apiGet('/admin/top')
    setInfo({ crowiVersion, serverInfo, searchInfo })
  }

  return [info, fetchInfo] as const
}

const TopPage: FC<{}> = () => {
  const [t] = useTranslation()
  const { crowi, searchConfigured } = useContext(AdminContext)
  const [{ crowiVersion, serverInfo, searchInfo }, fetchInfo] = useInfo(crowi)
  const { node, indexName, esVersion } = searchInfo

  useEffect(() => {
    fetchInfo()
  }, [])

  return (
    <>
      <p>
        {t('admin.top.description')}
        <br />
        {t('admin.top.appoint_admin')}
      </p>
      <h2>Information</h2>
      <dl className="row">
        <dt className="col-3">Crowi Version</dt>
        <dd className="col-9">{crowiVersion}</dd>
        <dt className="col-3">Node arch / version</dt>
        <dd className="col-9">
          {serverInfo.node.arch} / {serverInfo.node.version}
        </dd>
        <dt className="col-3">Search</dt>
        <dd className="col-9">
          {/* TODO: multiple nodes */}
          {searchConfigured ? (
            <>
              Configured: {node}/{indexName}, <strong>{esVersion}</strong>
            </>
          ) : (
            'Not available.'
          )}
        </dd>
      </dl>
    </>
  )
}

export default TopPage
