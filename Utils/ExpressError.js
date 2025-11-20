// ExpressErrorクラスを作成
// ExpressErrorクラスはErrorクラスを継承している
class ExpressError extends Error {
    constructor( message, statusCode) {
        //親クラスのconstructorも実行出来る様に呼んでおく
        super();
        this.message = message;
        this.statusCode = statusCode;
    }
}
//外からも使えるようにエクスポート
module.exports = ExpressError;