import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, Table } from 'reactstrap'

interface Props {
  users: any[]
  clear: () => void
}

const InvitedUserModal: FC<Props> = ({ users, clear }) => {
  return (
    <Modal isOpen={users.length > 0} toggle={clear}>
      <ModalHeader toggle={clear}>ユーザーを招待しました</ModalHeader>
      <ModalBody>
        <p>
          作成したユーザーは仮パスワードが設定されています。
          <br />
          仮パスワードはこの画面を閉じると二度と表示できませんのでご注意ください。
          <span className="text-danger">招待メールを送っていない場合、この画面で必ず仮パスワードをコピーし、招待者へ連絡してください。</span>
        </p>
        <Table>
          <thead>
            <tr>
              <th>メールアドレス</th>
              <th>パスワード</th>
            </tr>
          </thead>
          <tbody>
            {users.map(({ user, email, password }) => (
              <tr key={email}>
                <td>
                  <pre>{email}</pre>
                </td>
                <td>{user ? <pre>{password}</pre> : <span className="text-danger">作成失敗</span>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </ModalBody>
    </Modal>
  )
}

export default InvitedUserModal
