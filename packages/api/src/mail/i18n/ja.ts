import type { MailCatalog } from './index';

export const ja: MailCatalog = {
  invite: {
    subject: '{{ appTitle }} への招待',
    preheader: '招待を受けてアカウントをセットアップしてください。',
    heading: '招待が届いています',
    intro: 'Wiki に招待されました。下のボタンからユーザー名とパスワードを設定して、アカウントを有効化してください。',
    cta: '招待を受ける',
    expiresNote: 'この招待リンクは 7 日間有効です。',
    ignoreNote: 'この招待に心当たりがない場合は、このメールを無視してください。',
  },
  activation: {
    subject: '{{ appTitle }} のメールアドレス確認',
    preheader: 'メールアドレスを確認してアカウントを有効化してください。',
    heading: 'メールアドレスの確認',
    intro: 'ご登録ありがとうございます。下のボタンからメールアドレスを確認して、アカウントを有効化してください。',
    cta: 'メールアドレスを確認',
    expiresNote: 'この確認リンクは 24 時間有効です。',
    ignoreNote: 'このアカウントに心当たりがない場合は、このメールを無視してください。',
  },
  passwordReset: {
    subject: '{{ appTitle }} のパスワード再設定',
    preheader: 'パスワードを再設定してください。',
    heading: 'パスワードの再設定',
    intro: 'パスワード再設定のリクエストを受け付けました。下のボタンから新しいパスワードを設定してください。',
    cta: 'パスワードを再設定',
    expiresNote: 'このパスワード再設定リンクは 1 時間有効です。',
    ignoreNote: 'パスワード再設定をリクエストしていない場合は、このメールを無視してください。パスワードは変更されません。',
  },
  test: {
    subject: '{{ appTitle }}: テストメール',
    preheader: 'メール設定は正常に動作しています。',
    heading: 'メール設定は正常に動作しています',
    intro: 'これは管理画面のメール設定から送信されたテストメールです。これが届いていれば、メール送信は正しく設定されています。',
  },
  passwordChanged: {
    subject: '{{ appTitle }} のパスワードが変更されました',
    preheader: 'パスワードが変更されました。',
    heading: 'パスワードが変更されました',
    intro: 'あなたのアカウントのパスワードが変更されたことをお知らせします。',
    ignoreNote: 'この変更に心当たりがない場合は、ただちにパスワードを再設定し、管理者に連絡してください。',
  },
  adminApprovalPending: {
    subject: '{{ appTitle }} に承認待ちのユーザーがいます',
    preheader: '自己登録したユーザーの承認が必要です。',
    heading: '承認待ちのユーザーがいます',
    intro: '新しいユーザーが登録し、管理者による承認を待っています:',
    cta: 'ユーザーを確認',
  },
  emailChange: {
    subject: '{{ appTitle }} の新しいメールアドレスの確認',
    preheader: '新しいメールアドレスを確認してください。',
    heading: '新しいメールアドレスの確認',
    intro: 'あなたのアカウントのメールアドレスをこのアドレスに変更するリクエストがありました。下のボタンをクリックして変更を確定してください。',
    cta: '新しいメールアドレスを確認',
    expiresNote: 'この確認リンクは 24 時間有効です。',
    ignoreNote: 'この変更に心当たりがない場合は、このメールを無視してください。メールアドレスは変更されません。',
  },
  common: {
    footerTagline: 'Empower the team with sharing your knowledge.',
    linkFallback: '上のボタンが動作しない場合は、次の URL をブラウザに貼り付けてください:',
  },
};
