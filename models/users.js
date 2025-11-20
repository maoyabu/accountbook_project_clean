const mongoose = require('mongoose');
const { Schema } = mongoose;
const passportLocalMongoose = require('passport-local-mongoose');
const bcrypt = require('bcrypt');

const userSchema = new Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    displayname: {
        type: String
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    birth_date:{
        type: Date,
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    },
    avatar: {
        type: String
    },
    blood: {
        type: String
    },
    rh: {
        type: String
    },
    sex: {
        type: String
    },
    resetPasswordToken: {
        type: String
    },
    resetPasswordExpires: {
        type: Date
    },
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        default: []
      }],
    unsubscribe_date: {
        type: Date
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    isPlanner: {
        type: Boolean,
        default: false
    },
    isMail: {
        type: Boolean,
        default: true
    },
    services: {
        allaboutme: { type: Boolean, default: true },
        finance: { type: Boolean, default: true },
        assets: { type: Boolean, default: true }
    }
});

userSchema.methods.validatePassword = async function (inputPassword) {
    if (!this.password) {
        throw new Error("ユーザーのパスワードが存在しません");
    }
    return bcrypt.compare(inputPassword, this.password);
};

//エラーメッセージを日本語にする
userSchema.plugin(passportLocalMongoose, {
    selectFields: ['username', 'password'], // ← 追加
    errorMessages: {
        UserExistsError: 'そのユーザー名はすでに使われています',
        MissingPasswordError: 'パスワードを入力してください',
        AttemptTooSoonError: 'アカウントがロックされています。時間をあけて再度試してください',
        TooManyAttemptsError: 'ログインの失敗が何度も続いたため、アカウントがロックされています',
        NoSaltValueStoredError: '認証が出来ませんでした。',
        MissingUsernameError: 'ユーザー名を入力してください',
        IncorrectUsernameError: 'ユーザー名が間違っています',
        IncorrectPasswordError: 'パスワードが間違っています'
    }
});

module.exports = mongoose.model('User', userSchema);