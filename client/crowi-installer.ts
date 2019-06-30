$(function() {
  $('#register-form input[name="registerForm[username]"]').change(function(e) {
    var username = $(this).val()
    $('#input-group-username').removeClass('has-error')
    $('#help-block-username').html('')

    $.getJSON('/_api/check_username', { username: username }, function(json) {
      if (!json.valid) {
        $('#help-block-username').html('<i class="fa fa-exclamation-triangle"></i>このユーザーIDは利用できません。<br>')
        $('#input-group-username').addClass('has-error')
      }
    })
  })
})
