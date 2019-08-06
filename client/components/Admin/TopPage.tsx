import React, { useContext, useEffect, useState, FC } from 'react'

import { AdminContext } from 'components/Admin/AdminPage'

interface Info {
  crowiVersion: string | null
  searchInfo: {
    host?: string
    indexName?: string
    esVersion?: string
  }
}

function useInfo(crowi) {
  const [info, setInfo] = useState<Info>({ crowiVersion: null, searchInfo: {} })

  const fetchInfo = async () => {
    const { crowiVersion, searchInfo } = await crowi.apiGet('/admin/top')
    setInfo({ crowiVersion, searchInfo })
  }

  return [info, fetchInfo] as const
}

const TopPage: FC<{}> = () => {
  const { crowi, searchConfigured } = useContext(AdminContext)
  const [{ crowiVersion, searchInfo }, fetchInfo] = useInfo(crowi)
  const { host, indexName, esVersion } = searchInfo

  useEffect(() => {
    fetchInfo()
  }, [])

  return (
    <>
      <p>
        この画面はWiki管理者のみがアクセスできる画面です。
        <br />
        「ユーザー管理」から「管理者にする」ボタンを使ってユーザーをWiki管理者に任命することができます。
      </p>
      <h2>Information</h2>
      <dl className="row">
        <dt className="col-3">Crowi Version</dt>
        <dd className="col-9">{crowiVersion}</dd>
        <dt className="col-3">Search</dt>
        <dd className="col-9">
          {/* TODO: multiple nodes */}
          {searchConfigured ? (
            <>
              Configured: {host}
              {indexName}, <strong>{esVersion}</strong>
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
