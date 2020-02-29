import React, { useState, useEffect, useCallback, FC } from 'react'
import { Modal, ModalHeader, ModalBody } from 'reactstrap'

const HelpPortalModal: FC = () => {
  const [show, setShow] = useState(false)

  const handleOpen = useCallback(() => {
    setShow(true)
  }, [setShow])

  const handleClose = useCallback(() => {
    setShow(false)
  }, [setShow])

  useEffect(() => {
    $(document).on('click', '[data-target="#help-portal"]', handleOpen)
  }, [handleOpen])

  return (
    <Modal isOpen={show} toggle={handleClose} size="lg">
      <ModalHeader toggle={handleClose}>What is Portal?</ModalHeader>
      <ModalBody>
        <h4 className="pb-3">Portal とは</h4>
        <ul>
          <li>
            すべての、スラッシュ <code>/</code> で終わるページは、その階層の一覧ページとなります。
          </li>
          <li>
            Portal 機能を使うと、その一覧ページに対して、任意の編集コンテンツを配置することができるようになります
            (つまり、一般的なページと同様に、編集したコンテンツを作成でき、その内容は常にページ一覧の上部に表示されるようになります)
          </li>
        </ul>
        <hr />

        <h4 className="pb-3">想定される使われ方</h4>
        <p>例えば、以下のようなページの階層があったとします。</p>
        <ul>
          <li>
            <code>/projects</code>
            <ul>
              <li>
                <code>/projects/homepage-renewal</code>
                <ul>
                  <li>
                    <code>/projects/homepage-renewal/...</code>
                  </li>
                </ul>
              </li>
              <li>
                <code>/projects/...</code>
              </li>
            </ul>
          </li>
        </ul>

        <p>
          こういったケースでは、<code>/projects/homepage-renewal</code> には homepage-renewal
          プロジェクトについてのイントロや各ページへのリンク、関係者の紹介など、homepage-renewal に関する情報を掲載しておきたいと思うはずです。
        </p>
        <p>
          Portal機能を使うと、こうしたときに、<code>/projects/homepage-renewal/</code> この{' '}
          <strong>
            &quot;一覧ページ&quot; を、ページ化することができ、そこに、通常のページと同じように Markdown
            で編集したコンテンツを配置することができるようになります
          </strong>
          。
        </p>

        <p>まさにそのプロジェクトのポータルページを用意したい場合などに活用してください。</p>
      </ModalBody>
    </Modal>
  )
}

export default HelpPortalModal
